import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class SteganographyService {
  // URL of your Python Flask backend (change port if needed)
  private GAN_API_URL = 'http://localhost:5000/generate-image';

  // Null character used as end-of-message terminator inside the image
  private TERMINATOR = String.fromCharCode(0);

  constructor(private http: HttpClient) {}

  // ─────────────────────────────────────────────
  // PUBLIC: Called by home-page when SENDING
  // Returns a base64 PNG with the message hidden inside
  // ─────────────────────────────────────────────
  async encodeMessageIntoGANImage(encryptedText: string): Promise<string> {
    // Step 1: Ask Flask backend for a GAN-generated image
    const response: any = await firstValueFrom(this.http.get(this.GAN_API_URL));
    const ganImageBase64: string = response.image; // base64 PNG string

    // Step 2: Embed the encrypted text into the image using LSB steganography
    const stegoBase64 = await this.embedTextInBase64Image(ganImageBase64, encryptedText);
    return stegoBase64;
  }

  // ─────────────────────────────────────────────
  // PUBLIC: Called by home-page when RECEIVING
  // Takes a Firebase Storage URL, downloads image, extracts hidden text
  // ─────────────────────────────────────────────
  async decodeMessageFromImageUrl(imageUrl: string): Promise<string> {
    // Step 1: Download the stego image as base64
    const base64 = await this.urlToBase64(imageUrl);

    // Step 2: Extract the hidden encrypted text from the image
    const extractedText = await this.extractTextFromBase64Image(base64);
    return extractedText;
  }

  // ─────────────────────────────────────────────
  // PRIVATE: LSB Encode — hides text in image pixels
  // ─────────────────────────────────────────────
  private embedTextInBase64Image(base64Image: string, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        // Convert text + terminator to binary string
        const fullText = text + this.TERMINATOR;
        const binaryText = this.textToBinary(fullText);

        // Capacity check: each pixel holds 3 bits (R, G, B LSBs)
        const maxBits = (imageData.data.length / 4) * 3;
        if (binaryText.length > maxBits) {
          reject('Message too long for this image');
          return;
        }

        // Write bits into R, G, B LSBs (skip Alpha channel — index i+3)
        let bitIndex = 0;
        for (let i = 0; i < imageData.data.length && bitIndex < binaryText.length; i += 4) {
          imageData.data[i]     = (imageData.data[i]     & 0xFE) | parseInt(binaryText[bitIndex++] ?? '0');
          if (bitIndex < binaryText.length)
            imageData.data[i + 1] = (imageData.data[i + 1] & 0xFE) | parseInt(binaryText[bitIndex++] ?? '0');
          if (bitIndex < binaryText.length)
            imageData.data[i + 2] = (imageData.data[i + 2] & 0xFE) | parseInt(binaryText[bitIndex++] ?? '0');
        }

        ctx.putImageData(imageData, 0, 0);
        // Return as base64 PNG (without the data:image/png;base64, prefix)
        const fullDataUrl = canvas.toDataURL('image/png');
        resolve(fullDataUrl.split(',')[1]); // strip the prefix
      };

      img.onerror = () => reject('Failed to load image for encoding');
      img.src = 'data:image/png;base64,' + base64Image;
    });
  }

  // ─────────────────────────────────────────────
  // PRIVATE: LSB Decode — extracts text from image pixels
  // ─────────────────────────────────────────────
  private extractTextFromBase64Image(base64Image: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;

        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

        let bits = '';
        let result = '';

        for (let i = 0; i < imageData.data.length; i += 4) {
          // Read LSB of R, G, B
          bits += (imageData.data[i]     & 0x01).toString();
          bits += (imageData.data[i + 1] & 0x01).toString();
          bits += (imageData.data[i + 2] & 0x01).toString();

          // Process complete bytes
          while (bits.length >= 8) {
            const byte = bits.substring(0, 8);
            bits = bits.substring(8);
            const charCode = parseInt(byte, 2);

            if (charCode === 0) {
              // Terminator found — message is complete
              resolve(result);
              return;
            }
            result += String.fromCharCode(charCode);
          }
        }

        // If no terminator found, return whatever was extracted
        resolve(result);
      };

      img.onerror = () => reject('Failed to load image for decoding');

      // Handle both full data URLs and plain base64
      if (base64Image.startsWith('data:')) {
        img.src = base64Image;
      } else {
        img.src = 'data:image/png;base64,' + base64Image;
      }
    });
  }

  // ─────────────────────────────────────────────
  // PRIVATE: Download image from URL → base64
  // ─────────────────────────────────────────────
  private urlToBase64(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous'; // needed for Firebase Storage URLs

      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject('Canvas not supported'); return; }
        ctx.drawImage(img, 0, 0);
        const fullDataUrl = canvas.toDataURL('image/png');
        resolve(fullDataUrl.split(',')[1]); // return only the base64 part
      };

      img.onerror = () => reject('Failed to download image from URL: ' + url);
      img.src = url;
    });
  }

  // ─────────────────────────────────────────────
  // PRIVATE: Convert text string → binary string
  // ─────────────────────────────────────────────
  private textToBinary(text: string): string {
    return text
      .split('')
      .map((char) => char.charCodeAt(0).toString(2).padStart(8, '0'))
      .join('');
  }

  // ─────────────────────────────────────────────
  // PUBLIC HELPER: Convert base64 string → File object
  // Used by image-upload.service to upload to Firebase
  // ─────────────────────────────────────────────
  base64ToFile(base64: string, filename: string): File {
    const byteString = atob(base64);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    for (let i = 0; i < byteString.length; i++) {
      uint8Array[i] = byteString.charCodeAt(i);
    }
    const blob = new Blob([uint8Array], { type: 'image/png' });
    return new File([blob], filename, { type: 'image/png' });
  }
}