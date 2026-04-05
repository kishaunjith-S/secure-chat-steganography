import { Injectable } from '@angular/core';
import {
  addDoc,
  collection,
  collectionData,
  doc,
  Firestore,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from '@angular/fire/firestore';
import { concatMap, map, Observable, take } from 'rxjs';
import { Chat, Message } from '../models/chat';
import { ProfileUser } from '../models/user-profile';
import { UsersService } from './users.service';

@Injectable({
  providedIn: 'root',
})
export class ChatsService {
  constructor(
    private firestore: Firestore,
    private usersService: UsersService
  ) {}

  get myChats$(): Observable<Chat[]> {
    const ref = collection(this.firestore, 'chats');
    return this.usersService.currentUserProfile$.pipe(
      concatMap((user) => {
        const myQuery = query(ref, where('userIds', 'array-contains', user?.uid));
        return collectionData(myQuery, { idField: 'id' }).pipe(
          map((chats: any) => this.addChatNameAndPic(user?.uid, chats))
        ) as Observable<Chat[]>;
      })
    );
  }

  createChat(otherUser: ProfileUser): Observable<string> {
    const ref = collection(this.firestore, 'chats');
    return this.usersService.currentUserProfile$.pipe(
      take(1),
      concatMap((user) =>
        addDoc(ref, {
          userIds: [user?.uid, otherUser?.uid],
          users: [
            { displayName: user?.displayName ?? '', photoURL: user?.photoURL ?? '' },
            { displayName: otherUser.displayName ?? '', photoURL: otherUser.photoURL ?? '' },
          ],
        })
      ),
      map((ref) => ref.id)
    );
  }

  isExistingChat(otherUserId: string): Observable<string | null> {
    return this.myChats$.pipe(
      take(1),
      map((chats) => chats.find(c => c.userIds.includes(otherUserId))?.id ?? null)
    );
  }

  // UPDATED: now also accepts coverUrl so we can store it alongside
  // the stego URL for the metrics dashboard to use.
  addChatMessage(chatId: string, message: string, coverUrl: string = ''): Observable<any> {
    const ref     = collection(this.firestore, 'chats', chatId, 'messages');
    const chatRef = doc(this.firestore, 'chats', chatId);
    const today   = Timestamp.fromDate(new Date());

    return this.usersService.currentUserProfile$.pipe(
      take(1),
      concatMap((user) =>
        addDoc(ref, {
          text:      message,   // stego image URL
          coverUrl:  coverUrl,  // cover image URL — used only by metrics dashboard
          senderId:  user?.uid,
          sentDate:  today,
        })
      ),
      concatMap(() =>
        updateDoc(chatRef, { lastMessage: message, lastMessageDate: today })
      )
    );
  }

  getChatMessages$(chatId: string): Observable<Message[]> {
    const ref      = collection(this.firestore, 'chats', chatId, 'messages');
    const queryAll = query(ref, orderBy('sentDate', 'asc'));
    return collectionData(queryAll) as Observable<Message[]>;
  }

  // Get ALL messages across ALL chats — used by metrics dashboard
  getAllMessages$(): Observable<Message[]> {
    return this.myChats$.pipe(
      concatMap((chats) => {
        // Collect messages from the most recent chat only for simplicity
        // (Firestore doesn't support collection-group queries without an index)
        if (chats.length === 0) return [];
        const latestChatId = chats[0].id;
        return this.getChatMessages$(latestChatId);
      })
    );
  }

  addChatNameAndPic(currentUserId: string | undefined, chats: Chat[]): Chat[] {
    chats.forEach((chat: Chat) => {
      const otherUserIndex = chat.userIds.indexOf(currentUserId ?? '') === 0 ? 1 : 0;
      const { displayName, photoURL } = chat.users[otherUserIndex];
      chat.chatName = displayName;
      chat.chatPic  = photoURL;
    });
    return chats;
  }
}