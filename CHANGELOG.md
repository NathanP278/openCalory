# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.2.0] - 2026-11-24

### Added
- **10,500+ Verified Foods — 4x+ Offline Database Expansion**:
  - **Massive Multi-Source Catalog**: Expanded from the legacy 2,500-item list to **over 10,500+ verified foods**, unifying USDA SR Legacy & Foundation, MenuStat restaurant nutrition (global chains & fast food), national food composition tables, Open Food Facts, and curated international cuisine packs (Japanese, Korean, Thai, Vietnamese, Filipino, Italian, and more).
  - **Blazing Fast On-Device Search (<25ms)**: Powered by client-side SQLite-WASM running in an Origin Private File System (OPFS) Web Worker. Search across 10,500+ items completely offline with sub-25ms median query latencies.
  - **Ultra-Compact 2.1 MB Footprint**: Advanced compile-time deduplication and column compression packages an 11.5 MB database into an over-the-wire download of just ~2.1 MB.
  - **Typo Tolerance & Multilingual Aliases**: Native full-text search (FTS5) with phonetic matching, typo tolerance (e.g., `"chiken brest"` resolves instantly to Chicken Breast), canonical name normalization, and rich culinary serving units (cups, bowls, slices, pieces, grams).
  - **Bring Your Own Foods (CSV & JSON Importer)**: Full support for importing custom food datasets and restaurant menus directly through Settings with instant schema validation and on-device indexing.
  - **Server-Side Fallback & Streaming Delivery**: Added server-side SQLite FTS5 streaming endpoints and opt-in live external provider fallbacks for unified `/api/foods/search` and `/api/foods/barcode` resolution.
- **Catalog Management & Open Data Transparency**:
  - Live food catalog status and database health monitor in Settings.
  - Open Database License (ODbL) and transparent data source attribution.

### Changed
- **Replaced Legacy Search with SQLite FTS5**: Fully deprecated static JSON files (`staples-2500.json` & `ph-foods.json`), eliminating UI thread search lag and enabling unified, zero-latency autocomplete in food search and barcode scanner drawers.
- **Enhanced Portion Resolution**: Integrated intelligent serving size pickers with fractional amounts across the entire 10,500+ food catalog.

### Fixed
- **AI Scanning & Recognition**:
  - Added bounded retry logic with exponential backoff for transient meal scan network and provider failures.
  - Enforced micronutrient estimation requirements in meal scan outputs with automatic fallback enrichment.
  - Normalized meal scan and label OCR API responses, added fallback candidate retries, and properly surfaced OCR parsing errors.
- **Logging & Entry Editing**:
  - Added bidirectional recalculation of calories and macronutrients when modifying portions and serving sizes in logged entry edit drawers.
  - Improved mixed fraction quantity parsing (e.g. `1 1/2`), unit singularization, and search ranking for common staples.
- **Offline Storage & OPFS Workers**:
  - Hardened OPFS SQLite-WASM worker initialization with watchdog monitoring, asset path resolution, and catalog pre-persistence integrity verification.
  - Upgraded service worker caching (SW v4) for catalog manifests and navigation routes.
  - Resolved Open Food Facts streaming ID collisions and national CSV parsing discrepancies.
- **UI & Mobile Ergonomics**:
  - Synchronized mobile `visualViewport` metrics to prevent on-screen keyboards from displacing bottom navigation and drawers on iOS Safari and mobile Chrome.
  - Improved Apple Health integration status tracking to require verified incoming iOS Shortcut calls before displaying "Connected".

### Documentation
- Updated Apple Health integration guide to a streamlined 5-step iOS Personal Automation setup.

## [v0.1.0] - 2026-11-22

### Added
- **AI-Powered Nutrition & Scanning**:
  - Multimodal and text-only meal scanning with human-in-the-loop (HITL) review sheet and micronutrient estimates.
  - "Fill My Remaining Macros" AI meal ideas generator feeding directly into staging review.
  - Camera-based barcode scanner drawer with native-resolution ROI decoding and missing-barcode manual / AI OCR label creator.
  - Multi-key and model fallback for Gemini and OpenAI-compatible AI endpoints with parallel health checks and strict Zod validation.
- **Nutrition Tracking & Food Database**:
  - Comprehensive food search with 2,500+ offline Philippine/global staples dataset, USDA API proxy, and Open Food Facts offline-first waterfall.
  - Extended nutrient tracking including 6 micronutrients, Net Carbs, and Potassium-to-Sodium (K:Na) ratio across food sources.
  - Recents, Frequent, and Pinned food tabs with 1-tap quick-logging and multi-item staging.
  - Custom recipe builder with portion picker, cooked-weight overrides, full database ingredient search, and custom food creation.
  - Quick Add calorie and macro drawer with instant logging.
- **Coaching & Analytics**:
  - Dynamic coaching engine featuring Exponential Moving Average (EMA) trend weight, observed TDEE solver, and weekly calorie cycling.
  - Dedicated `/trends` analytics workspace with Weekly Check-In card, 30-day interactive shaded heatmap, and zero-dependency SVG trend charts.
  - Weigh-in drawer with Apple Health Shortcuts sync endpoint (`/api/weight/latest`) and guided setup.
  - 7-day pace telemetry card and Top Contributors breakdown sheets on the dashboard.
- **Storage, Sync & Offline Support**:
  - Local-first IndexedDB storage via Dexie schema v2.
  - Central Turso (libSQL) cloud database with tombstone-aware offline synchronization and `SYNC_ACCESS_KEY` authentication.
  - Versioned JSON backup (`openCalory-backup.json`) with transactional export/import and formula-safe CSV exports.
  - Progressive Web App (PWA) manifest and offline service worker caching.
- **UI & Motion Design**:
  - Volumetric liquid glass and Smoked Apple Liquid Glass design system with semantic dark tokens and capsule controls.
  - Responsive layout system supporting desktop sidebar rail, tablet split view, and mobile bottom navigation.
  - Spring physics motion architecture with staggered card cascades, morphing tabs, number rolling, and interactive drawer gestures.
  - Self-hosting infrastructure with multi-platform Docker configuration and production compose setup.
  - Integration with Vercel Web Analytics and Speed Insights.

### Changed
- Modernized app shell and navigation: promoted Trends to bottom navigation, relocated Settings to header action, and added quick Weigh-In dock shortcut.
- Flattened diary entries into a unified, slot-free food diary timeline with portion scaling, date moving, and notes drawer.
- Redesigned daily nutrition progress arc, telemetry density, and responsive multi-day bento cards.
- Streamlined recipe management cards, protected tab pill sizing, and unified recipe toolbars.
- Optimized mobile settings into a compact scrollable layout with deduplicated 7-day pace metrics.
- Elevated search modal on desktop viewports and unified ambient light gradient transitions.

### Fixed
- **Scanner & OCR**: Resolved barcode scanner reliability and performance with native-resolution ROI decoding; fixed duplicate scan callbacks, scanner lock resets, and per-100g metric serving sizes in custom food OCR.
- **PWA & Layout**: Centered offline banner and undo toasts across desktop and mobile; fixed mobile notch clipping and decoupled modal entrance animation from horizontal centering.
- **Data & Synchronization**: Aligned weight logs index ordering, fixed tombstone sync on replaced offline entries, and secured API route headers against stale caching.
- **Calculations & Rounding**: Prevented recipe rounding drift, aligned `recordedAt` timestamps during backfilled weigh-ins, and resolved custom food macro scaling.
- **Performance**: Statically scoped search paths to eliminate whole-project build tracing and reduce build cache uploads.

### Documentation
- Added comprehensive project README with openCalory features, architecture, and retina device previews.
- Added GitHub community health files: Code of Conduct, Contributing guide, Issue templates, Pull Request template, and Security Policy.
- Added self-hosting setup guide and environment variable documentation.

[v0.2.0]: https://github.com/NathanP278/openCalory/compare/v0.1.0...v0.2.0
[v0.1.0]: https://github.com/NathanP278/openCalory/releases/tag/v0.1.0
