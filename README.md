# WhatsApp AI Assistant & Real-Time Chat Platform

A complete, production-ready, two-tier architecture consisting of an isolated **NestJS backend** and a modern **React Native (Expo) mobile client**.

---

## Key Highlights & Architecture

- **Backend (`backend/`)**:
  - **Framework**: NestJS (TypeScript) with feature-based modular folder structure (`auth`, `whatsapp`, `chats`, `messages`, `contacts`, `ai`, `extractions`, `settings`, `retention`, `gateway`).
  - **Database**: Supabase PostgreSQL connected via Prisma ORM (`backend/prisma/schema.prisma`).
  - **AI Intelligence Layer**: Powered by **Google Gemini 2.5 Flash** for message classification, automatic structured entity extraction, contact persona intelligence profiling (tone, Hinglish/English mix, emoji usage, likes/dislikes), and 3-option contextual reply suggestions.
  - **Multi-Tenant Isolation**: Strict isolation at the database level (`whatsapp_account_id` and `user_id` enforced on every query). No user can access or query another user's WhatsApp contacts, chats, or extractions.
  - **Real-Time Communication**: Socket.IO WebSocket Gateway with JWT authentication, user-specific rooms, and instant event broadcasting (`whatsapp.status`, `whatsapp.sync`, `message.new`, `message.sent`, `message.delivered`, `message.read`, `ai.extraction.created`).
  - **WhatsApp Integration Engine**: Multi-session engine supporting QR code authentication, 8-character pairing codes, state synchronization, and realistic automated testing pipeline.
  - **Automated Data Retention Worker**: Scheduled background job enforcing user data retention policies (7, 15, 30, 90 days), safely purging raw expired messages while retaining derived AI memories.

- **Frontend (`frontend/`)**:
  - **Framework**: React Native with Expo, TypeScript, and feature-based architecture.
  - **Navigation**: React Navigation with Auth Stack, WhatsApp Connection Flow, and Bottom Tab Navigator (`Dashboard`, `Chats`, `Contacts`, `Extractions`, `Settings`).
  - **Design System**: Warm Off-White wallpaper (`#ECE5DD`), Deep Green header branding (`#075E54`), Teal accents (`#128C7E` / `#25D366`), white card surfaces with soft elevation shadows, and clean light-themed UI (no dark mode).
  - **Zero Static Mock Data**: All screens load real, live database data via Axios REST APIs and update dynamically via WebSocket events.
  - **Optimistic Chat Messaging**: Real-time sending with instant UI insertion, delivery ticks (`SENDING` ⏳, `SENT` ✓, `DELIVERED` ✓✓, `READ` ✓✓ blue), and a bottom AI Reply Suggestions drawer with 1-tap send.

---

## Directory Structure

```
VAI-4/
├── backend/                         # NestJS Backend Service
│   ├── prisma/
│   │   └── schema.prisma            # Supabase PostgreSQL schema
│   ├── src/
│   │   ├── modules/
│   │   │   ├── auth/                # JWT authentication & registration
│   │   │   ├── whatsapp/            # WhatsApp session manager & sync pipeline
│   │   │   ├── chats/               # Conversation queries & pagination
│   │   │   ├── messages/            # Real-time sending & message history
│   │   │   ├── contacts/            # Contact directory & details
│   │   │   ├── ai/                  # Gemini 2.5 AI classification & reply suggestions
│   │   │   ├── extractions/         # Categorized AI memory hub
│   │   │   ├── settings/            # User preferences & retention policies
│   │   │   ├── retention/           # Automated scheduled message cleanup worker
│   │   │   └── gateway/             # Socket.IO WebSocket gateway
│   │   ├── prisma/                  # Global Prisma service
│   │   ├── app.module.ts            # Root module
│   │   └── main.ts                  # Bootstrap file
│   ├── test_e2e.js                  # 14-scenario automated test suite
│   └── .env                         # Supabase & Gemini credentials
│
├── frontend/                        # React Native Mobile Application
│   ├── src/
│   │   ├── features/
│   │   │   ├── auth/                # Login & Register screens
│   │   │   ├── whatsapp/            # WhatsApp Connect QR & Pairing code screen
│   │   │   ├── dashboard/           # AI Highlights, Birthdays, Meetings & Reply widgets
│   │   │   ├── chats/               # Chat List & Chat Detail with AI drawer
│   │   │   ├── contacts/            # Contacts directory & Contact AI Profile
│   │   │   ├── extractions/         # Filterable AI Memory hub (Birthdays, Meetings, etc.)
│   │   │   └── settings/            # Profile, Retention policy & Preferences
│   │   ├── navigation/              # Root & Tab navigation
│   │   └── shared/                  # API client, Socket client, Theme, Types
│   ├── App.tsx                      # Root App entry point
│   └── app.json                     # Expo configuration
│
└── PLANNING/                        # Architecture & Planning reference documents
```

---

## How to Run the Project

### 1. Running the Backend
The backend requires a MongoDB replica-set connection and a private JWT signing secret.
Create the backend environment file before starting it:
```bash
cd backend
npm install
npx prisma generate
Copy-Item .env.example .env
```
Edit `backend/.env` and set `DATABASE_URL` to your MongoDB replica-set connection string. For the local setup, use:
```env
DATABASE_URL="mongodb://127.0.0.1:27018/vai4?replicaSet=rs0"
```
Generate a strong JWT secret in PowerShell with:
```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Put the generated value in `JWT_SECRET` in `backend/.env`. Do not commit or share this file. `OPENROUTER_API_KEY` is optional; AI extraction and reply suggestions remain disabled until it is configured.

For local MongoDB on Windows, install MongoDB Server under `C:\Program Files\MongoDB\Server`. The startup helper detects an installed version, starts a dedicated replica set on port `27018`, and initializes it automatically:
```powershell
npx prisma db push
npm start
```
For MongoDB Atlas or another remote replica set, configure its URL in `.env` instead; `start_db.js` only manages the local MongoDB instance. Run `npx prisma db push` after setting `DATABASE_URL`. `npm start` builds the backend before launching it on `http://localhost:3000`. If a healthy backend is already running on the configured port, startup reports that instead of trying to launch a duplicate.

To run the automated 14-scenario end-to-end test suite:
```bash
node test_e2e.js
```

### 2. Running the Mobile App
From the root directory:
```bash
cd frontend
npm install
npm start
```
Press:
- `w` to open in your web browser
- `a` to run on Android emulator / device via Expo Go
- `i` to run on iOS simulator via Expo Go
