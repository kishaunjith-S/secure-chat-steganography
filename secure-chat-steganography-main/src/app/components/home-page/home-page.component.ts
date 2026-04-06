import { Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { FormControl } from '@angular/forms';
import {
  combineLatest,
  map,
  Observable,
  of,
  startWith,
  switchMap,
  tap,
} from 'rxjs';
import { Message } from 'src/app/models/chat';
import { ProfileUser } from 'src/app/models/user-profile';
import { ChatsService } from 'src/app/services/chats.service';
import { UsersService } from 'src/app/services/users.service';
import { SteganographyService, StegoResult } from 'src/app/services/steganography.service';
import { ImageUploadService } from 'src/app/services/image-upload.service';
import { EcdhService } from 'src/app/services/ecdh.service';
import * as CryptoJS from 'crypto-js';
import { firstValueFrom } from 'rxjs';

// ── Fallback key used ONLY if ECDH handshake has not yet completed.
// This preserves backward compatibility with messages sent before ECDH.
const FALLBACK_AES_KEY = 'my-secret-key';

function isStegoImageUrl(text: string): boolean {
  return (
    text.startsWith('https://firebasestorage.googleapis.com') ||
    text.startsWith('https://storage.googleapis.com')
  );
}

@Component({
  selector: 'app-home',
  templateUrl: './home-page.component.html',
  styleUrls: ['./home-page.component.scss'],
})
export class HomeComponent implements OnInit {
  @ViewChild('endOfChat') endOfChat!: ElementRef;

  user$    = this.usersService.currentUserProfile$;
  myChats$ = this.chatsService.myChats$;
  messages$: Observable<Message[]> | undefined;

  searchMessage   = new FormControl('');
  searchControl   = new FormControl('');
  messageControl  = new FormControl('');
  chatListControl = new FormControl('');

  isSendingMessage  = false;
  isHandshaking     = false;   // true while ECDH key exchange is in progress
  handshakeError    = '';      // shown to user if ECDH times out

  private decodedMessageCache: { [url: string]: string } = {};

  // Tracks which chatIds have a completed ECDH key (chatId → hexKey string)
  // Hex keys are cached here so we don't re-export the CryptoKey on every
  // message send/receive.
  private chatKeyCache: { [chatId: string]: string } = {};

  otherUsers$ = combineLatest([this.usersService.allUsers$, this.user$]).pipe(
    map(([users, user]) => users.filter((u) => u.uid !== user?.uid))
  );

  users$ = combineLatest([
    this.otherUsers$,
    this.searchMessage.valueChanges.pipe(startWith('')),
  ]).pipe(
    map(([users, searchString]) =>
      users.filter((u) =>
        u.displayName?.toLowerCase().includes((searchString ?? '').toLowerCase())
      )
    )
  );

  selectedChat$ = combineLatest([
    this.chatListControl.valueChanges,
    this.myChats$,
  ]).pipe(map(([value, chats]) => chats.find((c) => c.id === value[0])));

  constructor(
    private usersService: UsersService,
    private chatsService: ChatsService,
    private stegoService: SteganographyService,
    private imageUploadService: ImageUploadService,
    private ecdhService: EcdhService
  ) {}

  ngOnInit(): void {
    this.messages$ = this.chatListControl.valueChanges.pipe(
      map((value) => value[0]),
      switchMap((chatId) => {
        // Kick off ECDH handshake when a chat is selected
        if (chatId) this.startEcdhHandshake(chatId);
        return this.chatsService.getChatMessages$(chatId);
      }),
      tap(() => this.scrollToBottom())
    );
  }

  /**
   * Initiates ECDH handshake for the selected chat.
   * Looks up the other participant's UID from the chat document,
   * then calls EcdhService.initHandshake().
   */
  private async startEcdhHandshake(chatId: string): Promise<void> {
    // If key already cached for this chat, nothing to do
    if (this.chatKeyCache[chatId]) return;

    this.isHandshaking  = true;
    this.handshakeError = '';

    try {
      const me    = await firstValueFrom(this.user$);
      const chats = await firstValueFrom(this.myChats$);
      const chat  = chats.find(c => c.id === chatId);

      if (!me?.uid || !chat) {
        this.handshakeError = 'Could not identify chat participants.';
        return;
      }

      // Find the other participant (chat.userIds is string[])
      const theirUid = (chat as any).userIds?.find((uid: string) => uid !== me.uid);
      if (!theirUid) {
        this.handshakeError = 'Could not find peer user ID.';
        return;
      }

      // Run ECDH — waits up to 30s for peer's public key
      await this.ecdhService.initHandshake(chatId, me.uid, theirUid);

      // Export as hex for CryptoJS consumption
      const hexKey = await this.ecdhService.exportKeyAsHex(chatId);
      this.chatKeyCache[chatId] = hexKey;

      console.log(`[HomeComponent] ECDH complete for chat ${chatId}`);

    } catch (err: any) {
      console.error('[HomeComponent] ECDH handshake failed:', err);
      this.handshakeError =
        'Key exchange timed out — peer may be offline. ' +
        'Messages will use the fallback key until both parties are online.';
    } finally {
      this.isHandshaking = false;
    }
  }

  /**
   * Returns the AES key for a chat:
   * - ECDH-derived hex key if handshake is complete
   * - Fallback constant key otherwise
   */
  private getAesKey(chatId: string): string | CryptoJS.lib.WordArray {
    const hexKey = this.chatKeyCache[chatId];
    if (hexKey) {
      // Parse hex string into CryptoJS WordArray for use as a raw key
      return CryptoJS.enc.Hex.parse(hexKey);
    }
    // Fallback: pre-shared string key (backward compatible)
    return FALLBACK_AES_KEY;
  }

  async sendMessage(): Promise<void> {
    const message        = this.messageControl.value?.trim();
    const selectedChatId = this.chatListControl.value?.[0];
    if (!message || !selectedChatId) return;

    this.isSendingMessage = true;
    this.messageControl.disable();

    try {
      // Use ECDH-derived key if available, fallback otherwise
      const aesKey        = this.getAesKey(selectedChatId);
      const encryptedText = CryptoJS.AES.encrypt(message, aesKey).toString();
      const timestamp     = Date.now();

      const { stegoBase64, coverBase64 }: StegoResult =
        await this.stegoService.encodeMessageIntoGANImage(encryptedText);

      const imageUrl = await this.imageUploadService.uploadBase64Image(
        stegoBase64, selectedChatId
      );

      const coverUrl = await this.imageUploadService.uploadCoverImage(
        coverBase64, selectedChatId, timestamp
      );

      this.chatsService
        .addChatMessage(selectedChatId, imageUrl, coverUrl)
        .subscribe(() => this.scrollToBottom());

      this.messageControl.setValue('');

    } catch (error) {
      console.error('Error sending stego message:', error);
      alert('Failed to send message. Make sure the GAN backend (app.py) is running.');
    } finally {
      this.isSendingMessage = false;
      this.messageControl.enable();
    }
  }

  getDecryptedMessage(storedText: string): string {
    if (!storedText) return '';
    if (this.decodedMessageCache[storedText]) return this.decodedMessageCache[storedText];

    if (isStegoImageUrl(storedText)) {
      this.decodedMessageCache[storedText] = '🔓 Decoding...';

      const selectedChatId = this.chatListControl.value?.[0];
      const aesKey         = selectedChatId ? this.getAesKey(selectedChatId) : FALLBACK_AES_KEY;

      this.stegoService
        .decodeMessageFromImageUrl(storedText)
        .then((encryptedText) => {
          const plainText = CryptoJS.AES.decrypt(encryptedText, aesKey)
            .toString(CryptoJS.enc.Utf8);
          this.decodedMessageCache[storedText] = plainText || '[Decode failed]';
        })
        .catch(() => {
          this.decodedMessageCache[storedText] = '[Failed to decode image]';
        });

      return this.decodedMessageCache[storedText];
    }

    try {
      const selectedChatId = this.chatListControl.value?.[0];
      const aesKey         = selectedChatId ? this.getAesKey(selectedChatId) : FALLBACK_AES_KEY;
      const plain          = CryptoJS.AES.decrypt(storedText, aesKey).toString(CryptoJS.enc.Utf8);
      this.decodedMessageCache[storedText] = plain || storedText;
    } catch {
      this.decodedMessageCache[storedText] = storedText;
    }
    return this.decodedMessageCache[storedText];
  }

  createChat(user: ProfileUser): void {
    this.chatsService
      .isExistingChat(user.uid)
      .pipe(switchMap((chatId) => chatId ? of(chatId) : this.chatsService.createChat(user)))
      .subscribe((chatId) => this.chatListControl.setValue([chatId]));
  }

  scrollToBottom(): void {
    setTimeout(() => {
      this.endOfChat?.nativeElement.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  }
}