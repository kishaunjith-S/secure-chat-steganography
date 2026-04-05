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
import * as CryptoJS from 'crypto-js';

const AES_KEY = 'my-secret-key';

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

  isSendingMessage = false;

  private decodedMessageCache: { [url: string]: string } = {};

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
    private imageUploadService: ImageUploadService
  ) {}

  ngOnInit(): void {
    this.messages$ = this.chatListControl.valueChanges.pipe(
      map((value) => value[0]),
      switchMap((chatId) => this.chatsService.getChatMessages$(chatId)),
      tap(() => this.scrollToBottom())
    );
  }

  async sendMessage(): Promise<void> {
    const message        = this.messageControl.value?.trim();
    const selectedChatId = this.chatListControl.value?.[0];
    if (!message || !selectedChatId) return;

    this.isSendingMessage = true;
    this.messageControl.disable();

    try {
      const encryptedText = CryptoJS.AES.encrypt(message, AES_KEY).toString();
      const timestamp     = Date.now();

      // Get both stego and cover images from the service
      const { stegoBase64, coverBase64 }: StegoResult =
        await this.stegoService.encodeMessageIntoGANImage(encryptedText);

      // Upload stego image (the one sent as message)
      const imageUrl = await this.imageUploadService.uploadBase64Image(
        stegoBase64, selectedChatId
      );

      // Upload cover image silently — only used by the metrics dashboard
      const coverUrl = await this.imageUploadService.uploadCoverImage(
        coverBase64, selectedChatId, timestamp
      );

      // Save both URLs to Firestore — coverUrl is invisible to normal users
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

      this.stegoService
        .decodeMessageFromImageUrl(storedText)
        .then((encryptedText) => {
          const plainText = CryptoJS.AES.decrypt(encryptedText, AES_KEY)
            .toString(CryptoJS.enc.Utf8);
          this.decodedMessageCache[storedText] = plainText || '[Decode failed]';
        })
        .catch(() => {
          this.decodedMessageCache[storedText] = '[Failed to decode image]';
        });

      return this.decodedMessageCache[storedText];
    }

    try {
      const plain = CryptoJS.AES.decrypt(storedText, AES_KEY).toString(CryptoJS.enc.Utf8);
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