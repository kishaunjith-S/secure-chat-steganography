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
import * as CryptoJS from 'crypto-js';

// 🔥 Firebase Storage
import { Storage, ref, uploadBytes, getDownloadURL } from '@angular/fire/storage';

@Component({
  selector: 'app-home',
  templateUrl: './home-page.component.html',
  styleUrls: ['./home-page.component.scss'],
})
export class HomeComponent implements OnInit {

  @ViewChild('endOfChat') endOfChat!: ElementRef;
  @ViewChild('fileInput') fileInput!: ElementRef; // 🔥 for clearing file input

  user$ = this.usersService.currentUserProfile$;
  myChats$ = this.chatsService.myChats$;

  searchMessage = new FormControl('');
  searchControl = new FormControl('');
  messageControl = new FormControl('');
  chatListControl = new FormControl('');

  messages$: Observable<Message[]> | undefined;

  selectedFile: File | null = null;

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
    private storage: Storage // 🔥 Firebase Storage
  ) { }

  ngOnInit(): void {
    this.messages$ = this.chatListControl.valueChanges.pipe(
      map((value) => value[0]),
      switchMap((chatId) => this.chatsService.getChatMessages$(chatId)),
      tap(() => this.scrollToBottom())
    );
  }

  // 🔥 FILE SELECT
  onFileSelected(event: any) {
    this.selectedFile = event.target.files[0];
  }

  createChat(user: ProfileUser) {
    this.chatsService
      .isExistingChat(user.uid)
      .pipe(
        switchMap((chatId) =>
          chatId ? of(chatId) : this.chatsService.createChat(user)
        )
      )
      .subscribe((chatId) => {
        this.chatListControl.setValue([chatId]);
      });
  }

  // 🔐 DECRYPT MESSAGE
  getDecryptedMessage(encryptedMessage: string): string {
    if (!encryptedMessage) return '';
    return CryptoJS.AES.decrypt(encryptedMessage, 'my-secret-key')
      .toString(CryptoJS.enc.Utf8);
  }

  // 🚀 SEND MESSAGE (TEXT + IMAGE)
  async sendMessage() {
    const message = this.messageControl.value;
    const selectedChatId = this.chatListControl.value[0];

    if (!selectedChatId) return;

    let finalMessage = message || '';

    // 🔥 Upload image if selected
    if (this.selectedFile) {
      try {
        const filePath = `chat-images/${Date.now()}_${this.selectedFile.name}`;
        const storageRef = ref(this.storage, filePath);

        await uploadBytes(storageRef, this.selectedFile);
        const downloadURL = await getDownloadURL(storageRef);

        finalMessage += ` [img:${downloadURL}]`;
      } catch (error) {
        console.error('Upload failed:', error);
        alert('Image upload failed');
        return;
      }
    }


    if (!finalMessage.trim()) return;

    // 🔐 Encrypt
    const encryptedMessage = CryptoJS.AES.encrypt(
      finalMessage,
      'my-secret-key'
    ).toString();

    // 📤 Send
    this.chatsService
      .addChatMessage(selectedChatId, encryptedMessage)
      .subscribe(() => {
        this.scrollToBottom();
      });

    // 🧹 Reset
    this.messageControl.setValue('');
    this.selectedFile = null;

    // 🔥 clear file input UI
    if (this.fileInput) {
      this.fileInput.nativeElement.value = '';
    }
  }

  scrollToBottom() {
    setTimeout(() => {
      if (this.endOfChat) {
        this.endOfChat.nativeElement.scrollIntoView({
          behavior: 'smooth',
        });
      }
    }, 100);
  }
  downloadImage(url: string) {
    fetch(url)
      .then(response => response.blob())
      .then(blob => {
        const blobUrl = window.URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = 'chat-image.png'; // you can customize name
        document.body.appendChild(link);
        link.click();

        document.body.removeChild(link);
        window.URL.revokeObjectURL(blobUrl);
      })
      .catch(err => {
        console.error('Download failed:', err);
      });
  }
  openImage(url: string) {
    window.open(url, '_blank');
  }
}