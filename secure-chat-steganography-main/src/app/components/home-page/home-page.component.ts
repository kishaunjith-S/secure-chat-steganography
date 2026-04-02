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
import { SteganographyService } from 'src/app/services/steganography.service'; // NEW
import { ImageUploadService } from 'src/app/services/image-upload.service';   // NEW
import * as CryptoJS from 'crypto-js';

// ── Shared AES key (same as before — keep it consistent across your app) ──
const AES_KEY = 'my-secret-key';

// ── Helper: check if a string is a Firebase Storage URL (our stego messages) ──
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
  @ViewChild('endOfChat')
  endOfChat!: ElementRef;

  user$ = this.usersService.currentUserProfile$;
  myChats$ = this.chatsService.myChats$;

  searchMessage = new FormControl('');
  searchControl = new FormControl('');
  messageControl = new FormControl('');
  chatListControl = new FormControl('');

  messages$: Observable<Message[]> | undefined;

  // ── NEW: shown in the UI while GAN + stego processing happens ──
  isSendingMessage = false;

  // ── NEW: cache for decoded messages so we don't decode the same URL repeatedly ──
  private decodedMessageCache: { [url: string]: string } = {};

  otherUsers$ = combineLatest([this.usersService.allUsers$, this.user$]).pipe(
    map(([users, user]) => users.filter((u) => u.uid !== user?.uid))
  );

  users$ = combineLatest([
    this.otherUsers$,
    this.searchControl.valueChanges.pipe(startWith('')),
  ]).pipe(
    map(([users, searchString]) =>
      users.filter((u) =>
        u.displayName?.toLowerCase().includes(searchString.toLowerCase())
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
    private stegoService: SteganographyService,   // NEW
    private imageUploadService: ImageUploadService // NEW
  ) {}

  ngOnInit(): void {
    this.messages$ = this.chatListControl.valueChanges.pipe(
      map((value) => value[0]),
      switchMap((chatId) => this.chatsService.getChatMessages$(chatId)),
      tap(() => {
        this.scrollToBottom();
      })
    );
  }

  createChat(user: ProfileUser) {
    this.chatsService
      .isExistingChat(user.uid)
      .pipe(
        switchMap((chatId) => {
          if (!chatId) {
            return this.chatsService.createChat(user);
          } else {
            return of(chatId);
          }
        })
      )
      .subscribe((chatId) => {
        this.chatListControl.setValue([chatId]);
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SEND MESSAGE — full pipeline runs silently in background:
  //   1. AES encrypt the message text
  //   2. Call Flask GAN API → get a generated image (base64)
  //   3. Embed AES-encrypted text into the image (LSB steganography)
  //   4. Upload the stego image to Firebase Storage → get URL
  //   5. Store the URL in Firestore as the "message"
  // ─────────────────────────────────────────────────────────────────────────
  async sendMessage() {
    const message = this.messageControl.value?.trim();
    const selectedChatId = this.chatListControl.value?.[0];

    if (!message || !selectedChatId) return;

    // Disable input and show loading while processing
    this.isSendingMessage = true;
    this.messageControl.disable();

    try {
      // Step 1: AES encrypt (same as before)
      const encryptedText = CryptoJS.AES.encrypt(message, AES_KEY).toString();

      // Step 2 & 3: Generate GAN image and embed encrypted text into it
      const stegoBase64 = await this.stegoService.encodeMessageIntoGANImage(encryptedText);

      // Step 4: Upload stego image to Firebase Storage, get public URL
      const imageUrl = await this.imageUploadService.uploadBase64Image(stegoBase64, selectedChatId);

      // Step 5: Save the image URL to Firestore as the message
      this.chatsService
        .addChatMessage(selectedChatId, imageUrl)
        .subscribe(() => {
          this.scrollToBottom();
        });

      this.messageControl.setValue('');
    } catch (error) {
      console.error('Error sending stego message:', error);
      alert('Failed to send message. Make sure the GAN backend (app.py) is running.');
    } finally {
      this.isSendingMessage = false;
      this.messageControl.enable();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DECRYPT MESSAGE — called from the HTML template for each message bubble.
  // Returns a display string synchronously from the cache, and triggers
  // async decoding in the background for new messages.
  //
  // Flow:
  //   1. Check if the stored text is a Firebase Storage URL (our stego image)
  //   2. If yes: download image → extract LSB bits → AES decrypt → return text
  //   3. If no: treat as old-style plain AES encrypted text (backward compat)
  // ─────────────────────────────────────────────────────────────────────────
  getDecryptedMessage(storedText: string): string {
    if (!storedText) return '';

    // Return cached result immediately if we've decoded this URL before
    if (this.decodedMessageCache[storedText]) {
      return this.decodedMessageCache[storedText];
    }

    if (isStegoImageUrl(storedText)) {
      // Show placeholder while async decoding runs in background
      this.decodedMessageCache[storedText] = '🔓 Decoding...';

      // Kick off async decoding — result goes into cache, Angular re-renders
      this.stegoService
        .decodeMessageFromImageUrl(storedText)
        .then((encryptedText) => {
          // AES decrypt the extracted text
          const plainText = CryptoJS.AES.decrypt(encryptedText, AES_KEY)
            .toString(CryptoJS.enc.Utf8);
          this.decodedMessageCache[storedText] = plainText || '[Decode failed]';
        })
        .catch(() => {
          this.decodedMessageCache[storedText] = '[Failed to decode image]';
        });

      return this.decodedMessageCache[storedText]; // returns '🔓 Decoding...' on first call
    } else {
      // ── Backward compatibility: old messages stored as plain AES ciphertext ──
      try {
        const plain = CryptoJS.AES.decrypt(storedText, AES_KEY)
          .toString(CryptoJS.enc.Utf8);
        this.decodedMessageCache[storedText] = plain || storedText;
      } catch {
        this.decodedMessageCache[storedText] = storedText;
      }
      return this.decodedMessageCache[storedText];
    }
  }

  scrollToBottom() {
    setTimeout(() => {
      if (this.endOfChat) {
        this.endOfChat.nativeElement.scrollIntoView({ behavior: 'smooth' });
      }
    }, 100);
  }
}