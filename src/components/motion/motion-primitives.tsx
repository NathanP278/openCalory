"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  LayoutGroup,
  MotionConfig,
  motion,
  useReducedMotion,
  useSpring,
  type HTMLMotionProps,
  type Variants,
} from "motion/react";
import {
  DURATION_PAGE,
  DURATION_UI,
  EASE_EXPRESSIVE,
  SPRING_EXPRESSIVE,
  SPRING_SHEET,
  SPRING_SNAPPY,
  isTestEnvironment,
  type TransitionDirection,
} from "@/lib/motion";

/**
 * Root motion provider enforcing `prefers-reduced-motion` across the entire app
 * and enabling cross-route shared-element `layoutId` morphing.
 */
export function MotionRoot({ children }: { children: React.ReactNode }) {
  return (
    <MotionConfig reducedMotion="user" transition={SPRING_EXPRESSIVE}>
      <LayoutGroup id="opencalory-root">{children}</LayoutGroup>
    </MotionConfig>
  );
}

/**
 * Directional page entrance container for route transitions.
 * Slides in along the navigation vector (`x: ±40`) or rises smoothly (`y: 28`)
 * with subtle scale settle (`0.96 -> 1`) and opacity fade.
 */
export function PageTransitionStage({
  routeKey,
  direction,
  className = "",
  children,
}: {
  routeKey: string;
  direction: TransitionDirection;
  className?: string;
  children: React.ReactNode;
}) {
  const prefersReduced = useReducedMotion();
  const isTest = isTestEnvironment();

  const xOffset =
    prefersReduced || isTest
      ? 0
      : direction === "forward"
        ? 20
        : direction === "backward"
          ? -20
          : 0;
  const yOffset = prefersReduced || isTest ? 0 : direction ? 0 : 12;
  const initialScale = prefersReduced || isTest ? 1 : 0.985;

  return (
    <motion.main
      key={routeKey}
      style={{ viewTransitionName: "route-stage" }}
      initial={
        isTest
          ? false
          : {
              opacity: 0,
              x: xOffset,
              y: yOffset,
              scale: initialScale,
            }
      }
      animate={{
        opacity: 1,
        x: 0,
        y: 0,
        scale: 1,
      }}
      transition={{
        duration: prefersReduced ? 0.12 : DURATION_PAGE,
        ease: EASE_EXPRESSIVE,
      }}
      className={className}
    >
      {children}
    </motion.main>
  );
}

const staggerParentVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.04,
      delayChildren: 0.02,
    },
  },
};

const staggerChildVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 26,
    scale: 0.97,
  },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: SPRING_EXPRESSIVE,
  },
};

/**
 * Above-the-fold choreographed stagger parent (`staggerChildren: 0.08`, `delayChildren: 0.08`).
 */
export function PageStagger({
  children,
  className = "",
  ...rest
}: HTMLMotionProps<"div">) {
  const isTest = isTestEnvironment();
  return (
    <motion.div
      variants={staggerParentVariants}
      initial={isTest ? false : "hidden"}
      animate="visible"
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Staggered child block inside `PageStagger`.
 */
export function StaggerItem({
  children,
  className = "",
  ...rest
}: HTMLMotionProps<"div">) {
  const isTest = isTestEnvironment();
  return (
    <motion.div
      variants={isTest ? undefined : staggerChildVariants}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Below-the-fold scroll-triggered reveal using `whileInView`.
 * Falls back to immediate visibility in jsdom tests where IntersectionObserver is inactive.
 */
export function ScrollReveal({
  children,
  className = "",
  delay = 0,
  y = 36,
  ...rest
}: HTMLMotionProps<"div"> & { delay?: number; y?: number }) {
  const prefersReduced = useReducedMotion();
  const isTest = isTestEnvironment();

  if (isTest) {
    return (
      <div className={className} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        {children as React.ReactNode}
      </div>
    );
  }

  return (
    <motion.div
      initial={{
        opacity: 0,
        y: prefersReduced ? 0 : y,
        scale: prefersReduced ? 1 : 0.96,
      }}
      whileInView={{
        opacity: 1,
        y: 0,
        scale: 1,
      }}
      viewport={{ once: true, amount: 0.12 }}
      transition={{
        duration: prefersReduced ? 0.16 : 0.46,
        delay,
        ease: EASE_EXPRESSIVE,
      }}
      className={className}
      {...rest}
    >
      {children}
    </motion.div>
  );
}

/**
 * Spring-animated numeric counter that visibly rolls from 0 on mount and
 * springs smoothly to new targets whenever telemetry updates.
 * Snaps immediately under `prefers-reduced-motion` and inside jsdom tests.
 */
export function AnimatedNumber({
  value,
  format = (n: number) => Math.round(n).toLocaleString("en-US"),
  className = "",
}: {
  value: number;
  format?: (val: number) => string;
  className?: string;
}) {
  const safeTarget = Number.isFinite(value) ? value : 0;
  const prefersReduced = useReducedMotion();
  const isTest = isTestEnvironment();
  const skipAnimation = Boolean(prefersReduced) || isTest;

  const spring = useSpring(skipAnimation ? safeTarget : 0, {
    stiffness: 180,
    damping: 26,
    mass: 0.9,
  });

  const [display, setDisplay] = useState<string>(() => format(safeTarget));
  const formatRef = useRef(format);
  formatRef.current = format;

  useEffect(() => {
    if (skipAnimation) {
      spring.jump(safeTarget);
      setDisplay(formatRef.current(safeTarget));
      return;
    }
    spring.set(safeTarget);
  }, [safeTarget, skipAnimation, spring]);

  useEffect(() => {
    if (skipAnimation) return;
    const unsubscribe = spring.on("change", (latest) => {
      setDisplay(formatRef.current(latest));
    });
    return unsubscribe;
  }, [skipAnimation, spring]);

  return <span className={className}>{skipAnimation ? format(safeTarget) : display}</span>;
}

/**
 * Reusable `AnimatePresence`-powered modal/drawer backdrop + spring panel.
 * On mobile slides up from the bottom; on desktop scales in with crisp spring settle.
 */
export function MotionModalOverlay({
  open,
  onClose,
  ariaLabel,
  dataTestId,
  align = "sheet",
  panelClassName = "",
  backdropClassName = "",
  panelRef,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  ariaLabel: string;
  dataTestId?: string;
  align?: "sheet" | "center" | "top";
  panelClassName?: string;
  backdropClassName?: string;
  panelRef?: React.Ref<HTMLDivElement>;
  children: React.ReactNode;
}) {
  const prefersReduced = useReducedMotion();
  const isTest = isTestEnvironment();

  const containerAlign =
    align === "top"
      ? "items-start justify-center pt-[10vh] sm:pt-[14vh] px-4"
      : align === "center"
        ? "items-end sm:items-center justify-center p-4 sm:p-6"
        : "flex-col justify-end sm:items-center sm:justify-center sm:p-6";

  const initialPanel =
    prefersReduced || isTest
      ? { opacity: 0 }
      : align === "top"
        ? { opacity: 0, y: -24, scale: 0.95 }
        : { opacity: 0, y: 48, scale: 0.94 };

  const exitPanel =
    prefersReduced || isTest
      ? { opacity: 0 }
      : align === "top"
        ? { opacity: 0, y: -16, scale: 0.96 }
        : { opacity: 0, y: 36, scale: 0.95 };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          data-testid={dataTestId}
          initial={isTest ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={isTest ? undefined : { opacity: 0 }}
          transition={{ duration: prefersReduced ? 0.14 : 0.28, ease: EASE_EXPRESSIVE }}
          className={`modal-viewport-overlay z-50 flex ${containerAlign} bg-black/72 ${backdropClassName}`}
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            initial={isTest ? false : initialPanel}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={isTest ? undefined : exitPanel}
            transition={
              prefersReduced
                ? { duration: 0.15 }
                : SPRING_SHEET
            }
            className={panelClassName}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Wraps validation error messages or form sections to deliver an unmistakable
 * horizontal spring shake (`x: [-8, 8, -6, 6, -3, 3, 0]`) whenever `shakeKey` activates.
 */
export function ShakeOnError({
  shakeKey,
  className = "",
  children,
}: {
  shakeKey: string | number | null | undefined;
  className?: string;
  children: React.ReactNode;
}) {
  const prefersReduced = useReducedMotion();
  const isTest = isTestEnvironment();

  return (
    <motion.div
      key={shakeKey ? String(shakeKey) : "idle"}
      initial={isTest || !shakeKey ? false : { opacity: 0, y: -6 }}
      animate={
        shakeKey && !prefersReduced && !isTest
          ? {
              opacity: 1,
              y: 0,
              x: [-8, 8, -6, 6, -3, 3, 0],
            }
          : { opacity: 1, y: 0, x: 0 }
      }
      transition={{ duration: DURATION_UI, ease: EASE_EXPRESSIVE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/**
 * Interactive tactile button props preset for `motion.button` / `motion.a`.
 */
export const TACTILE_BUTTON_MOTION = {
  whileHover: { scale: 1.035, y: -1.5 },
  whileTap: { scale: 0.94 },
  transition: SPRING_SNAPPY,
} as const;

export const TACTILE_CARD_MOTION = {
  whileHover: { y: -5, scale: 1.01 },
  whileTap: { scale: 0.985 },
  transition: SPRING_EXPRESSIVE,
} as const;
