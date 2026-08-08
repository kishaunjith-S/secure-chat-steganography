# StegaShield — Project Documentation

Secure real-time chat application combining **ECDH key exchange**, **AES-256 encryption**,
**DCGAN-generated cover images**, and **LSB steganography**. Messages are never stored as
plaintext or ciphertext in the database — they exist only as URLs pointing to ordinary-looking
PNG images.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER (Angular app)                        │
│                                                                       │
│  ECDH handshake (Web Crypto API)  ──►  AES-256 key (in-memory only) │
│  AES encrypt message               ──►  ciphertext                  │
│  LSB-embed ciphertext into cover   ──►  stego image                 │
└───────────────┬──────────────────────────────────┬──────────────────┘
                │ GET /generate-image               │ upload image
                ▼                                    ▼
┌───────────────────────────┐          ┌──────────────────────────────┐
│   Flask backend (app.py)  │          │   Firebase (Auth/Firestore/  │
│   Loads trained DCGAN     │          │   Storage)                   │
│   Generator, returns a    │          │   - user accounts            │
│   fresh random PNG        │          │   - chat/message metadata    │
│   cover image on request  │          │   - public keys (handshake)  │
└───────────────────────────┘          │   - image files              │
                                        └──────────────────────────────┘
```

**Two backends, two different jobs:**
- **Firebase** — everything a normal chat app needs: accounts, live message sync, file storage.
  No custom server code required for this half.
- **Flask (`app.py`)** — exists for exactly one reason: Angular can't run a PyTorch model, so a
  tiny Python server loads the trained GAN and serves cover images over HTTP.

Everything cryptographic (ECDH, AES) and everything steganographic (LSB embed/extract) runs
**client-side in the browser**, not on any server. The server never sees plaintext, ciphertext,
or the AES key.

---

## 2. Message Flow (send → receive)

1. User opens a chat → ECDH handshake starts automatically for that chat.
2. Both browsers generate ephemeral P-256 key pairs, publish only their **public** key to
   Firestore, derive a shared AES-256 key locally via ECDH + HKDF-SHA256. The key never leaves
   the browser.
3. User types a message → encrypted client-side with AES (CryptoJS).
4. Browser requests a fresh cover image from Flask (`GET /generate-image`) — a DCGAN generator
   samples random noise and returns a synthetic 512×512 PNG.
5. Ciphertext is embedded into the cover image's pixels using LSB substitution (1 bit hidden per
   R/G/B channel per pixel, null-byte terminator marks the end of the payload).
6. The resulting **stego image** (and, separately, the original cover, for later comparison) is
   uploaded to Firebase Storage.
7. Firestore gets a message document whose `text` field is just the **Storage URL** of the stego
   image — not the message content.
8. Receiver downloads the image, extracts the hidden bits (LSB), decrypts with the same
   ECDH-derived AES key, displays the plaintext.

If the ECDH handshake hasn't completed yet (e.g. peer offline), a fallback pre-shared key is used
instead so the app doesn't hard-fail — this is a known compromise, not a security best practice.

---

## 3. Repository Structure

```
secure-chat-steganography/
├── app.py                          # Flask server — serves GAN cover images
├── train_gan.py                    # One-time offline DCGAN training script
├── generator.pth                   # Saved trained generator weights
├── stegashield_eval.py             # Offline evaluation/metrics script (SRM, PSNR, etc.)
├── srm_results.csv, stegashield_*.csv/.txt   # Generated metrics output (not source code)
│
└── secure-chat-steganography-main/ # Angular frontend
    └── src/app/
        ├── components/
        │   ├── login-page/            # Email/password login
        │   ├── sign-up-page/          # Registration
        │   ├── landing/               # Marketing/intro page
        │   ├── home-page/             # Main chat UI — orchestrates the full pipeline
        │   ├── profile-page/          # User profile editing
        │   ├── MFA/                   # Multi-factor auth UI (stub, not wired up)
        │   ├── Image-Steganography/   # Standalone LSB demo (OTP-gated, separate from main chat)
        │   └── metrics-dashboard/     # Live PSNR/chi-square/SRM dashboard
        ├── services/
        │   ├── authentication.service.ts   # Firebase Auth wrapper
        │   ├── users.service.ts            # Firestore user profile CRUD
        │   ├── chats.service.ts            # Firestore chat/message CRUD
        │   ├── ecdh.service.ts             # ECDH handshake + key derivation
        │   ├── steganography.service.ts    # LSB embed/extract + GAN API call
        │   └── image-upload.service.ts     # Firebase Storage upload helpers
        ├── models/                    # TypeScript interfaces (Chat, Message, ProfileUser)
        ├── pipes/                     # Display helpers (date formatting)
        └── environments/              # Firebase project config
```

---

## 4. Backend Reference

### `train_gan.py` — offline, run once
Trains a DCGAN (Radford et al., 2015) on a 5,000-image CIFAR-10 subset for 3 epochs (~2–4 min
on CPU). Standard adversarial training: Discriminator learns real-vs-fake, Generator learns to
fool it. Only the Generator's weights are saved (`generator.pth`) — the Discriminator is
training-only scaffolding and is discarded afterward.

```
python train_gan.py     # produces generator.pth
```

### `app.py` — Flask server, run continuously
Loads `generator.pth` into a `DCGANGenerator` instance, sets it to `.eval()` mode (inference,
not training).

**Endpoints:**
| Route | Method | Purpose |
|---|---|---|
| `/generate-image` | GET | Samples random noise → runs generator → returns a base64 PNG (upscaled to 512×512) |
| `/health` | GET | Reports server status and whether trained (vs. random-init) weights loaded |

```
python app.py           # serves on http://localhost:5000
```

**Must be running before any message can be sent** — the frontend calls `/generate-image`
synchronously as part of `sendMessage()`, and will show an error alert if the Flask server is
unreachable.

### `stegashield_eval.py` — offline evaluation only
Not part of the runtime app. Generates its own AES-256 test payloads, embeds them via LSB,
computes PSNR/MSE/bpp/chi-square/SRM steganalysis, and writes LaTeX-ready tables. Used to
produce paper results — safe to ignore when explaining how the *app* works.

---

## 5. Frontend Reference (brief)

| File | Responsibility |
|---|---|
| `ecdh.service.ts` | Generates ephemeral P-256 keys, publishes public key to Firestore, waits for peer's key, derives shared AES-256 key via ECDH + HKDF-SHA256. Private key and derived AES key never leave the browser. |
| `steganography.service.ts` | Calls Flask for a cover image; LSB-embeds/extracts text into/from image pixels via HTML5 Canvas. |
| `image-upload.service.ts` | Uploads stego/cover images and profile pictures to Firebase Storage, returns download URLs. |
| `chats.service.ts` | Firestore CRUD for chat documents and message subcollections. |
| `users.service.ts` | Firestore CRUD for user profile documents (separate from Firebase Auth identity). |
| `authentication.service.ts` | Thin wrapper over Firebase Auth (login/signup/logout). |
| `home-page.component.ts` | Orchestrates everything above: triggers handshake on chat open, runs encrypt → embed → upload → save on send, runs download → extract → decrypt on receive. |
| `Image-Steganography.component.ts` | **Standalone** LSB encode/decode demo with a locally-generated OTP as access control. Not connected to ECDH/AES/GAN — a separate teaching tool, not the main security path. |
| `MFA.component.ts` | Form UI only; submit handler currently just logs to console. Not a functional MFA flow yet. |
| `metrics-dashboard.component.ts` | Live in-browser recomputation of PSNR/MSE/chi-square/SRM on real sent messages, mirroring `stegashield_eval.py`. |

---

## 6. Setup / Run Order

```bash
# 1. Train the GAN once (only needed if generator.pth is missing/stale)
pip install torch torchvision pillow numpy
python train_gan.py

# 2. Start the GAN backend
pip install flask flask-cors
python app.py                      # http://localhost:5000

# 3. Start the Angular frontend (separate terminal)
cd secure-chat-steganography-main
npm install
ng serve                           # http://localhost:4200
```

Firebase project config lives in `src/environments/environment.ts` — a working `apiKey` must be
present for Auth/Firestore/Storage to function.

---

## 7. Known Gaps / Honest Limitations

- **Fallback AES key** (`'my-secret-key'`) is used if ECDH hasn't completed — availability
  tradeoff, not a hardened default.
- **MFA is UI-only**, not functionally wired to any verification backend.
- **`/is` route (Image-Steganography demo)** uses a locally-generated OTP compared in plaintext
  client-side — a demonstration of LSB steganography in isolation, not a secure access-control
  mechanism, and separate from the main ECDH+AES+GAN chat pipeline.
- **GAN is trained on a small CIFAR-10 subset** (5k images, 3 epochs) for speed — image
  photorealism was not the research focus; LSB capacity and statistical undetectability were.
- **`FilterMessagesPipe`** exists as a file but is empty/unused.