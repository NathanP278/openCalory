# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[v0.1.0]: https://github.com/NathanP278/openCalory/releases/tag/v0.1.0
