# Contributing to openCalory

Thanks for your interest in contributing to **openCalory**! Whether you are fixing a bug, improving accessibility, expanding food data coverage, or adding a new feature, contributions are welcome.

## Project Principles

Before making changes, please keep these core principles in mind:

1. **Adherence neutrality:** Never use punitive red warning styling or shame-oriented messaging when a user exceeds calorie or macro targets. Over-target states should remain calm, analytical, and neutral (`+N` / `Surplus`).
2. **Offline-first & local sovereignty:** Core logging, offline SQLite FTS5 catalog search, custom foods/recipes, trends, and backups must work locally in IndexedDB and OPFS without requiring cloud accounts or external APIs.
3. **Server-side secrets only:** API keys (`AI_API_KEY`, `TURSO_AUTH_TOKEN`, `SYNC_ACCESS_KEY`, `SHORTCUT_API_KEY`, `USDA_API_KEY`, and optional live food provider keys such as `FATSECRET_*`, `EDAMAM_*`, `NUTRITIONIX_*`) must never be exposed to client bundles, `NEXT_PUBLIC_*` variables, or browser storage.
4. **Mobile-first ergonomics, desktop elasticity:** Logging flows should stay fast and thumb-friendly on phones while expanding cleanly into multi-column layouts on tablets and desktops.
5. **Human-in-the-Loop (HITL) AI:** AI meal scans, label OCR, and meal ideas should always let the user inspect, adjust, or swap ingredients before logging.

## Local Development Setup

### Prerequisites

- **Node.js 20+** (Node 22 LTS recommended)
- **npm** (uses `package-lock.json`)

### Getting Started

1. Fork the repository on GitHub and clone your fork:

   ```bash
   git clone https://github.com/<your-username>/openCalory.git
   cd openCalory
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. (Optional) Create a `.env.local` file from the template:

   ```bash
   cp .env.example .env.local
   ```

   All environment variables are optional for local development—the app works out of the box with IndexedDB, the bundled 10,500+ food SQLite FTS5 catalog, and a local SQLite sync database (`opencalory.db`).

4. Start the development server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Scripts & Quality Checks

Run these before opening a pull request:

```bash
# Run the full Vitest test suite
npm test

# Run tests in watch mode while developing
npm run test:watch

# Run ESLint
npm run lint

# Verify the production Next.js build succeeds
npm run build

# Rebuild or pull the offline SQLite FTS5 food catalog
npm run food-db:build
npm run food-db:build:expanded
npm run food-db:pull
```

## Making Changes

1. Create a descriptive branch from `main`:

   ```bash
   git checkout -b feat/your-feature-name
   ```

2. Keep changes focused and modular. Add or update unit/component tests alongside your changes (`src/**/__tests__/*.test.ts(x)`).
3. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages where practical (e.g., `feat(trends): ...`, `fix(scanner): ...`, `docs: ...`).
4. Ensure `npm test`, `npm run lint`, and `npm run build` all pass with zero errors.
5. Open a Pull Request against `main` with a clear summary of what changed, why, and how you tested it. Include screenshots or screen recordings for UI changes (both dark and light themes if applicable).

## Reporting Issues

When opening an issue, please include:

- Steps to reproduce the problem
- Expected vs. actual behavior
- Hosting environment (Local Node.js, Docker, Vercel, browser/OS, PWA vs. browser tab)
- Relevant console/server logs (with any secrets redacted)
