# 🔐 Secure Chat with Image Steganography

A secure real-time chat application with **AES encryption** and **Image Steganography**, built using **Angular** and **Firebase**.

---

## 🚀 Features

- User Authentication (Email/Password)
- Real-time encrypted chat
- AES encrypted message storage
- Image Steganography (Encode & Decode)
- OTP-based image decoding
- Responsive UI

---

## 🛠️ Tech Stack

- Angular
- Firebase Authentication
- Cloud Firestore
- CryptoJS (AES Encryption)
- HTML5 Canvas (Steganography)
- TypeScript
- SCSS

---

## 📁 Project Structure

```
src/
 ├── app/
 │   ├── components/
 │   │   ├── home-page/
 │   │   ├── login-page/
 │   │   ├── sign-up-page/
 │   │   ├── profile-page/
 │   │   ├── Image-Steganography/
 │   ├── services/
 │   ├── models/
 │   ├── pipes/
 ├── environments/
```

---

## ⚙️ Installation & Setup

### 1️⃣ Install Requirements

- Node.js
- Angular CLI

Install Angular CLI:

```bash
npm install -g @angular/cli
```

---

### 2️⃣ Clone Repository

```bash
git clone https://github.com/kishaunjith-S/secure-chat-steganography.git
cd secure-chat-steganography
```

---

### 3️⃣ Install Dependencies

```bash
npm install
```

---

### 4️⃣ Configure Firebase

1. Create a Firebase project
2. Enable:
   - Authentication (Email/Password)
   - Firestore Database
3. Add your Firebase config inside:

```
src/environments/environment.ts
```

---

### 5️⃣ Run the Application

```bash
ng serve
```

Open browser:

```
http://localhost:4200/
```

---

## 🔐 Security Overview

### AES Encryption

Messages are encrypted before storing in Firestore and decrypted on retrieval.

### Image Steganography

- Secret message + OTP embedded inside image pixels
- OTP required for decoding
- Uses Least Significant Bit (LSB) technique
>>>>>>> a3edfad (Updated Readme)
