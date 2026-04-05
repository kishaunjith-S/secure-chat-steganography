import { Component, OnInit } from '@angular/core';
import {
  Firestore,
  collectionGroup,
  query,
  orderBy,
  limit,
  collectionData,
  collection,
  where,
} from '@angular/fire/firestore';
import { ChatsService } from 'src/app/services/chats.service';
import { firstValueFrom } from 'rxjs';

interface MessageMetrics {
  // Raw data
  stegoUrl:  string;
  coverUrl:  string;
  sentDate:  any;

  // Image info
  width:  number;
  height: number;
  totalPixels: number;
  capacityBytes: number;

  // Payload
  payloadBits:     number;
  payloadBytes:    number;
  capacityUsedPct: number;

  // Quality
  psnr: number;
  mse:  number;

  // Security
  bitsPerPixel:  number;
  detectionRisk: string;
  strengthScore: number;
  strengthLabel: string;

  // Chi-square
  chiSquare:       number;
  chiSquareResult: string;

  // State
  loading: boolean;
  error:   string;
}

@Component({
  selector: 'app-metrics-dashboard',
  templateUrl: './metrics-dashboard.component.html',
  styleUrls: ['./metrics-dashboard.component.scss'],
})
export class MetricsDashboardComponent implements OnInit {

  messages: MessageMetrics[] = [];
  isLoading = true;
  globalError = '';

  constructor(
    private firestore: Firestore,
    private chatsService: ChatsService
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      // Load all chats and then messages from each
      const chats = await firstValueFrom(this.chatsService.myChats$);

      if (!chats || chats.length === 0) {
        this.globalError = 'No chats found. Send some messages first.';
        this.isLoading = false;
        return;
      }

      // Gather messages from all chats that have a coverUrl
      const allMessages: MessageMetrics[] = [];

      for (const chat of chats) {
        const messagesRef = collection(this.firestore, 'chats', chat.id, 'messages');
        const q = query(messagesRef, orderBy('sentDate', 'desc'), limit(10));
        const docs = await firstValueFrom(collectionData(q) as any);

        for (const doc of (docs as any[])) {
          if (doc.coverUrl && doc.text &&
              doc.text.startsWith('https://firebasestorage')) {
            allMessages.push({
              stegoUrl:       doc.text,
              coverUrl:       doc.coverUrl,
              sentDate:       doc.sentDate,
              width: 0, height: 0, totalPixels: 0, capacityBytes: 0,
              payloadBits: 0, payloadBytes: 0, capacityUsedPct: 0,
              psnr: 0, mse: 0, bitsPerPixel: 0,
              detectionRisk: '', strengthScore: 0, strengthLabel: '',
              chiSquare: 0, chiSquareResult: '',
              loading: true, error: '',
            });
          }
        }
      }

      this.isLoading = false;

      if (allMessages.length === 0) {
        this.globalError = 'No stego messages with metrics data found. Send some messages first.';
        return;
      }

      // Sort newest first, take last 10
      this.messages = allMessages.slice(0, 10);

      // Compute metrics for each message in parallel
      await Promise.all(
        this.messages.map((m, i) => this.computeForMessage(i))
      );

    } catch (err) {
      console.error(err);
      this.globalError = 'Failed to load messages from Firestore.';
      this.isLoading = false;
    }
  }

  private async computeForMessage(index: number): Promise<void> {
    const m = this.messages[index];
    try {
      const [coverData, stegoData] = await Promise.all([
        this.loadImageDataFromUrl(m.coverUrl),
        this.loadImageDataFromUrl(m.stegoUrl),
      ]);

      const w = coverData.width;
      const h = coverData.height;
      const totalPixels  = w * h;
      const totalSlots   = totalPixels * 3;
      const capacityBytes = Math.floor(totalSlots / 8);

      // Count payload bits by comparing LSBs
      const payloadBits    = this.countDifferentLSBs(coverData.data, stegoData.data);
      const payloadBytes   = Math.ceil(payloadBits / 8);
      const capacityUsedPct = (payloadBits / totalSlots) * 100;

      const mse  = this.computeMSE(coverData.data, stegoData.data, totalPixels);
      const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);

      const bitsPerPixel = payloadBits / totalPixels;

      let detectionRisk: string;
      if (bitsPerPixel < 0.05)     detectionRisk = 'Very Low';
      else if (bitsPerPixel < 0.1) detectionRisk = 'Low';
      else if (bitsPerPixel < 0.5) detectionRisk = 'Medium';
      else                         detectionRisk = 'High';

      const psnrScore     = Math.min((isFinite(psnr) ? psnr : 60) / 60, 1) * 40;
      const capacityScore = Math.max(0, 1 - capacityUsedPct / 100) * 30;
      const sizeScore     = Math.min(totalPixels / (512 * 512), 1) * 30;
      const strengthScore = Math.round(psnrScore + capacityScore + sizeScore);

      let strengthLabel: string;
      if (strengthScore >= 80)      strengthLabel = 'Very Strong';
      else if (strengthScore >= 60) strengthLabel = 'Strong';
      else if (strengthScore >= 40) strengthLabel = 'Moderate';
      else                          strengthLabel = 'Weak';

      const { chiSquare, chiSquareResult } =
        this.chiSquareTest(stegoData.data, totalPixels);

      this.messages[index] = {
        ...m,
        width: w, height: h, totalPixels, capacityBytes,
        payloadBits, payloadBytes, capacityUsedPct,
        psnr, mse, bitsPerPixel,
        detectionRisk, strengthScore, strengthLabel,
        chiSquare, chiSquareResult,
        loading: false, error: '',
      };

    } catch (err) {
      this.messages[index] = {
        ...m,
        loading: false,
        error: 'Failed to load images for this message.',
      };
    }
  }

  // ── Computation helpers ───────────────────────────────────────
  private computeMSE(a: Uint8ClampedArray, b: Uint8ClampedArray, pixels: number): number {
    let sum = 0;
    for (let i = 0; i < a.length; i += 4) {
      sum += (a[i]   - b[i])   ** 2;
      sum += (a[i+1] - b[i+1]) ** 2;
      sum += (a[i+2] - b[i+2]) ** 2;
    }
    return sum / (3 * pixels);
  }

  private countDifferentLSBs(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    let count = 0;
    for (let i = 0; i < a.length; i += 4) {
      if ((a[i]   & 1) !== (b[i]   & 1)) count++;
      if ((a[i+1] & 1) !== (b[i+1] & 1)) count++;
      if ((a[i+2] & 1) !== (b[i+2] & 1)) count++;
    }
    return count;
  }

  private chiSquareTest(
    data: Uint8ClampedArray, pixels: number
  ): { chiSquare: number; chiSquareResult: string } {
    let zeros = 0, ones = 0;
    for (let i = 0; i < data.length; i += 4) {
      (data[i] & 1) === 0 ? zeros++ : ones++;
    }
    const expected  = pixels / 2;
    const chiSquare = ((zeros - expected) ** 2 + (ones - expected) ** 2) / expected;
    return {
      chiSquare:       parseFloat(chiSquare.toFixed(4)),
      chiSquareResult: chiSquare > 3.841 ? 'DETECTED' : 'NOT DETECTED',
    };
  }

  private loadImageDataFromUrl(url: string): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width  = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = () => reject('Failed to load: ' + url);
      img.src = url;
    });
  }

  // ── Template helpers ──────────────────────────────────────────
  formatPsnr(val: number): string {
    return isFinite(val) ? val.toFixed(2) + ' dB' : '∞';
  }

  formatDate(ts: any): string {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  }

  getScoreColor(score: number): string {
    if (score >= 80) return '#4caf50';
    if (score >= 60) return '#8bc34a';
    if (score >= 40) return '#ff9800';
    return '#f44336';
  }

  getPsnrColor(psnr: number): string {
    if (!isFinite(psnr) || psnr >= 50) return '#4caf50';
    if (psnr >= 40) return '#8bc34a';
    if (psnr >= 30) return '#ff9800';
    return '#f44336';
  }

  getRiskColor(risk: string): string {
    const map: Record<string, string> = {
      'Very Low': '#4caf50', 'Low': '#8bc34a',
      'Medium': '#ff9800',   'High': '#f44336',
    };
    return map[risk] ?? '#888';
  }

  getChiColor(result: string): string {
    return result === 'NOT DETECTED' ? '#4caf50' : '#f44336';
  }

  isFinite(val: number): boolean { return Number.isFinite(val); }
}