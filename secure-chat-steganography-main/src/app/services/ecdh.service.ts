import { Injectable } from '@angular/core';
import {
  Firestore,
  doc,
  setDoc,
  onSnapshot,
  getDoc,
} from '@angular/fire/firestore';

/**
 * EcdhService — ECDH key exchange using Web Crypto API + Firestore
 *
 * Protocol (Proposed Design — Section III of StegaShield paper):
 *   1. Each party generates an ephemeral P-256 key pair in the browser.
 *   2. The public key (JWK) is written to Firestore:
 *        handshakes/{chatId}/keys/{myUid}
 *   3. Each party listens for the other's public key.
 *   4. When both keys are present, the shared secret is derived:
 *        S = ECDH(myPrivateKey, theirPublicKey)
 *   5. HKDF-SHA256 derives a 256-bit AES-CBC key from S.
 *   6. The AES key lives in memory only — never written to Firestore.
 *
 * Reference:
 *   NIST SP 800-56A Rev. 3 — Recommendation for Pair-Wise Key-Establishment
 *   Schemes Using Discrete Logarithm Cryptography.
 */
@Injectable({
  providedIn: 'root',
})
export class EcdhService {

  // In-memory key store: chatId → derived CryptoKey (AES-256-CBC)
  private derivedKeys: Map<string, CryptoKey> = new Map();

  // In-memory key pair store: chatId → ephemeral CryptoKeyPair
  private keyPairs: Map<string, CryptoKeyPair> = new Map();

  constructor(private firestore: Firestore) {}

  /**
   * Initialise ECDH handshake for a given chat.
   * Call this when the user selects a chat (before sending the first message).
   *
   * @param chatId   Firestore chat document ID
   * @param myUid    Current user's Firebase UID
   * @param theirUid The other party's Firebase UID
   * @returns        Promise resolving to the derived AES-256 CryptoKey
   */
  async initHandshake(
    chatId: string,
    myUid: string,
    theirUid: string
  ): Promise<CryptoKey> {

    // Return cached key if handshake already complete for this chat
    const cached = this.derivedKeys.get(chatId);
    if (cached) return cached;

    // Step 1 — Generate ephemeral P-256 key pair
    const keyPair = await window.crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,   // extractable — needed to export public key to Firestore
      ['deriveKey', 'deriveBits']
    );
    this.keyPairs.set(chatId, keyPair);

    // Step 2 — Export public key as JWK and write to Firestore
    const publicKeyJwk = await window.crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const myKeyDocRef  = doc(this.firestore, `handshakes/${chatId}/keys/${myUid}`);
    await setDoc(myKeyDocRef, { publicKey: JSON.stringify(publicKeyJwk), uid: myUid });

    // Step 3 — Wait for the other party's public key
    const theirPublicKeyJwk = await this.waitForPeerKey(chatId, theirUid);

    // Step 4 — Import their public key
    const theirCryptoKey = await window.crypto.subtle.importKey(
      'jwk',
      theirPublicKeyJwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,   // not extractable
      []       // no usages needed for a public key
    );

    // Step 5 — Derive shared secret bits via ECDH
    const sharedBits = await window.crypto.subtle.deriveBits(
      { name: 'ECDH', public: theirCryptoKey },
      keyPair.privateKey,
      256   // 256 bits
    );

    // Step 6 — Derive AES-256-CBC key via HKDF-SHA256
    const hkdfKey = await window.crypto.subtle.importKey(
      'raw',
      sharedBits,
      { name: 'HKDF' },
      false,
      ['deriveKey']
    );

    const aesKey = await window.crypto.subtle.deriveKey(
      {
        name:   'HKDF',
        hash:   'SHA-256',
        salt:   new TextEncoder().encode('StegaShield-v1'),   // fixed salt
        info:   new TextEncoder().encode(chatId),              // chat-specific info
      },
      hkdfKey,
      { name: 'AES-CBC', length: 256 },
      true,    // extractable — needed to pass to CryptoJS as raw bytes
      ['encrypt', 'decrypt']
    );

    // Cache and return
    this.derivedKeys.set(chatId, aesKey);
    console.log(`[EcdhService] Key established for chat: ${chatId}`);
    return aesKey;
  }

  /**
   * Export the derived AES key as a hex string compatible with CryptoJS.
   * CryptoJS.AES.encrypt(message, CryptoJS.enc.Hex.parse(hexKey))
   */
  async exportKeyAsHex(chatId: string): Promise<string> {
    const key = this.derivedKeys.get(chatId);
    if (!key) throw new Error(`No derived key found for chat: ${chatId}`);
    const raw   = await window.crypto.subtle.exportKey('raw', key);
    return Array.from(new Uint8Array(raw))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /**
   * Returns true if a derived key exists in memory for this chat.
   */
  hasKey(chatId: string): boolean {
    return this.derivedKeys.has(chatId);
  }

  /**
   * Clears the cached key for a chat (e.g. on logout).
   */
  clearKey(chatId: string): void {
    this.derivedKeys.delete(chatId);
    this.keyPairs.delete(chatId);
  }

  /**
   * Clears all cached keys (call on logout).
   */
  clearAllKeys(): void {
    this.derivedKeys.clear();
    this.keyPairs.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Waits for the peer's public key to appear in Firestore.
   * Uses a real-time listener with a 30-second timeout.
   */
  private waitForPeerKey(chatId: string, peerUid: string): Promise<JsonWebKey> {
    return new Promise((resolve, reject) => {
      const peerDocRef = doc(this.firestore, `handshakes/${chatId}/keys/${peerUid}`);
      const timeout    = setTimeout(() => {
        unsubscribe();
        reject(new Error(
          `ECDH handshake timeout: peer ${peerUid} did not publish a public key within 30 seconds.`
        ));
      }, 30_000);

      const unsubscribe = onSnapshot(peerDocRef, (snapshot) => {
        if (snapshot.exists()) {
          const data = snapshot.data();
          if (data?.['publicKey']) {
            clearTimeout(timeout);
            unsubscribe();
            try {
              resolve(JSON.parse(data['publicKey']) as JsonWebKey);
            } catch {
              reject(new Error('Failed to parse peer public key JWK'));
            }
          }
        }
      }, (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}