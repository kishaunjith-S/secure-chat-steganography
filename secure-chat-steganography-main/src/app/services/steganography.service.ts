import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

export interface StegoResult {
  stegoBase64: string;  // the stego image (embedded)
  coverBase64: string;  // the original GAN image (before embedding)
}

@Injectable({
  providedIn: 'root',
})
export class SteganographyService {
  private GAN_API_URL = 'http://localhost:5000/generate-image';
  private TERMINATOR  = String.fromCharCode(0);

  constructor(private http: HttpClient) {}

  // ─────────────────────────────────────────────
  // PUBLIC: Called by home-page when SENDING
  // Now returns BOTH the stego image AND the cover
  // so we can store the cover for metrics later.
  // ─────────────────────────────────────────────
  async encodeMessageIntoGANImage(encryptedText: string): Promise<StegoResult> {
    const response: any = await firstValueFrom(this.http.get(this.GAN_API_URL));
    const coverBase64: string = response.image;
    const stegoBase64 = await this.embedTextInBase64Image(coverBase64, encryptedText);
    return { stegoBase64, coverBase64 };
  }

  // ─────────────────────────────────────────────
  // PUBLIC: Called by home-page when RECEIVING
  // ─────────────────────────────────────────────
  async decodeMessageFromImageUrl(imageUrl: string): Promise<string> {
    const base64 = await this.urlToBase64(imageUrl);
    return this.extractTextFromBase64Image(base64);
  }

  // ─────────────────────────────────────────────
  // PRIVATE: LSB Encode
  // ─────────────────────────────────────────────
  private embedTextInBase64Image(base64Image: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        const fullText   = text + this.TERMINATOR;
        const binaryText = this.textToBinary(fullText);
        const maxBits    = (imageData.data.length / 4) * 3;

        if (binaryText.length > maxBits) {
          reject('Message too long for this image');
          return;
        }

        let bitIndex = 0;
        for (let i = 0; i < imageData.data.length && bitIndex < binaryText.length; i += 4) {
          imageData.data[i]     = (imageData.data[i]     & 0xFE) | parseInt(binaryText[bitIndex++]);
          if (bitIndex < binaryText.length)
            imageData.data[i+1] = (imageData.data[i+1]   & 0xFE) | parseInt(binaryText[bitIndex++]);
          if (bitIndex < binaryText.length)
            imageData.data[i+2] = (imageData.data[i+2]   & 0xFE) | parseInt(binaryText[bitIndex++]);
        }

        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };

      img.onerror = () => reject('Failed to load image for encoding');
      img.src = 'data:image/png;base64,' + base64Image;
    });
  }

  // ─────────────────────────────────────────────
  // PRIVATE: LSB Decode
  // ─────────────────────────────────────────────
  private extractTextFromBase64Image(base64Image: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let bits   = '';
        let result = '';

        for (let i = 0; i < imageData.data.length; i += 4) {
          bits += (imageData.data[i]   & 0x01).toString();
          bits += (imageData.data[i+1] & 0x01).toString();
          bits += (imageData.data[i+2] & 0x01).toString();

          while (bits.length >= 8) {
            const charCode = parseInt(bits.substring(0, 8), 2);
            bits = bits.substring(8);
            if (charCode === 0) { resolve(result); return; }
            result += String.fromCharCode(charCode);
          }
        }

        resolve(result);
      };

      img.onerror = () => reject('Failed to load image for decoding');
      img.src = base64Image.startsWith('data:')
        ? base64Image
        : 'data:image/png;base64,' + base64Image;
    });
  }

  // ─────────────────────────────────────────────
  // PRIVATE: Firebase Storage URL → base64 PNG
  // ─────────────────────────────────────────────
  private urlToBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png').split(',')[1]);
      };
      img.onerror = () => reject('Failed to download image: ' + url);
      img.src = url;
    });
  }

  private textToBinary(text: string): string {
    return text.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join('');
  }

  base64ToFile(base64: string, filename: string): File {
    const bytes  = atob(base64);
    const buffer = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
    return new File([new Blob([buffer], { type: 'image/png' })], filename, { type: 'image/png' });
  }
}