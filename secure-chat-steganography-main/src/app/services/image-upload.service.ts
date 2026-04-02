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

  // ── Existing method (unchanged) ──────────────────────────────────────────
  uploadImage(image: File, path: string): Observable<string> {
    const storageRef = ref(this.storage, path);
    const uploadTask = from(uploadBytes(storageRef, image));
    return uploadTask.pipe(switchMap((result) => getDownloadURL(result.ref)));
  }

  // ── NEW: Upload a base64 PNG string to Firebase Storage ──────────────────
  // Returns a Promise<string> with the public download URL.
  // Called by home-page.component.ts after steganography encoding is done.
  async uploadBase64Image(base64: string, chatId: string): Promise<string> {
    // Create a unique filename using chatId + timestamp
    const filename = `stego_messages/${chatId}/${Date.now()}.png`;
    const storageRef = ref(this.storage, filename);

    // Firebase uploadString accepts base64 with 'base64' format flag
    const snapshot = await uploadString(storageRef, base64, 'base64', {
      contentType: 'image/png',
    });

    // Return the public download URL — this URL is stored in Firestore as the "message"
    const downloadUrl = await getDownloadURL(snapshot.ref);
    return downloadUrl;
  }
}