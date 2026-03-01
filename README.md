🔐 Secure Chat with Image Steganography

A secure real-time chat application with AES encryption and Image Steganography, built using Angular and Firebase.

This project demonstrates secure communication using:

🔒 AES Encryption for text messages

🖼️ Image Steganography for hidden message sharing

🔥 Firebase Authentication & Firestore for backend

⚡ Real-time messaging

🚀 Features

User Authentication (Email/Password)

Real-time encrypted chat

AES encrypted message storage

Image Steganography (Encode & Decode)

OTP-based image decoding

Responsive UI

Angular-based frontend

Firebase backend

🛠️ Tech Stack

Angular

Firebase Authentication

Cloud Firestore

CryptoJS (AES Encryption)

HTML5 Canvas (Steganography)

TypeScript

SCSS

📦 Project Structure
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
⚙️ Installation & Setup
1️⃣ Install Requirements

Node.js

Angular CLI

Install Angular CLI:

npm install -g @angular/cli
2️⃣ Clone Repository
git clone https://github.com/kishaunjith-S/secure-chat-steganography.git
cd secure-chat-steganography
3️⃣ Install Dependencies
npm install
4️⃣ Configure Firebase

Create a Firebase project

Enable:

Authentication (Email/Password)

Firestore Database

Add your Firebase config inside:

src/environments/environment.ts
5️⃣ Run the Application
ng serve

Open browser:

http://localhost:4200/
🔐 How Security Works
AES Chat Encryption

Messages are encrypted using CryptoJS AES before storing in Firestore.

Encrypted → Stored → Decrypted on retrieval
Image Steganography

Secret message + OTP is embedded inside image pixels

OTP required for decoding

Uses Least Significant Bit (LSB) technique

📚 Educational Purpose

This project is developed for learning and demonstration of:

Secure Communication

Cryptography Concepts

Steganography

Real-time Web Applications
