import { Injectable } from '@angular/core';
import {
  getDownloadURL,
  ref,
  Storage,
  uploadBytes,
  uploadString,
} from '@angular/fire/storage';
import { from, Observable, switchMap } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class ImageUploadService {
  constructor(private storage: Storage) {}

  uploadImage(image: File, path: string): Observable<string> {
    const storageRef  = ref(this.storage, path);
    const uploadTask  = from(uploadBytes(storageRef, image));
    return uploadTask.pipe(switchMap((result) => getDownloadURL(result.ref)));
  }

  async uploadBase64Image(base64: string, chatId: string): Promise<string> {
    const filename    = `stego_messages/${chatId}/${Date.now()}.png`;
    const storageRef  = ref(this.storage, filename);
    const snapshot    = await uploadString(storageRef, base64, 'base64', { contentType: 'image/png' });
    return getDownloadURL(snapshot.ref);
  }

  // NEW: Upload the cover image to a separate path so the metrics
  // dashboard can download it and compare it against the stego image.
  async uploadCoverImage(base64: string, chatId: string, timestamp: number): Promise<string> {
    const filename   = `cover_images/${chatId}/${timestamp}.png`;
    const storageRef = ref(this.storage, filename);
    const snapshot   = await uploadString(storageRef, base64, 'base64', { contentType: 'image/png' });
    return getDownloadURL(snapshot.ref);
  }
}