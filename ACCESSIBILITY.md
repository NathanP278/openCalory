# Accessibility Statement for openCalory

**openCalory** is committed to providing an accessible, usable experience for all users regardless of ability, device, or input method.

## Standards and Conformance

We strive to conform to the [Web Content Accessibility Guidelines (WCAG) 2.1](https://www.w3.org/TR/WCAG21/) Level AA standards across all responsive viewports.

### Key Accessibility Features Implemented

1. **Semantic HTML & ARIA:** Core controls and navigation elements use standard HTML elements (`<button>`, `<dialog>`, `<nav>`, `<main>`, `<header>`) or accessible Base UI / Radix primitives with appropriate ARIA roles and labels.
2. **Keyboard Navigation & Focus Management:**
   - Modals and adaptive sheets trap focus when open and release it on close.
   - All interactive controls provide visible, high-contrast focus rings (`--ring`).
   - Standard keyboard shortcuts are supported (e.g., `Escape` closes drawers and dialogs, `⌘K` / `Ctrl+K` opens the Command Palette).
3. **Motion Sensitivity:**
   - Animations, hover transforms, spring physics, and canvas sheen effects respect the user's system preferences via `@media (prefers-reduced-motion: reduce)`.
4. **Contrast & Theme Adaptability:**
   - Text, data markings, and interactive components maintain high contrast ratios in both Dark Mode (`#1E2229` canvas) and Light Mode (`#F2F4F8` canvas).
   - Numeric telemetry utilizes `tabular-nums` for consistent column alignment and readability.
5. **Screen Reader Support:**
   - Visual-only progress indicators (such as calorie horseshoe arcs and macro progress bars) include screen-reader-only accessible labels and values (`sr-only`).

## Feedback and Reporting Issues

If you experience accessibility barriers while using openCalory or have recommendations for improvement, please open a GitHub issue or contact the maintainers. We treat accessibility bugs with high priority.
