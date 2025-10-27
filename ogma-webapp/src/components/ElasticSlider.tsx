import React, { useEffect, useRef, useState } from "react";
import { animate, motion, useMotionValue, useMotionValueEvent, useTransform } from "motion/react";

const MAX_OVERFLOW = 50;

type ElasticSliderProps = {
  /** Текущее значение (0..100). Если не задано — работает как неуправляемый, от defaultValue. */
  value?: number;
  /** Старт (обычно 0) и максимум (обычно 100) */
  startingValue?: number;
  maxValue?: number;
  /** Начальное значение для неуправляемого режима */
  defaultValue?: number;
  /** Шаг (если нужен ступенчатый режим) */
  isStepped?: boolean;
  stepSize?: number;
  /** Классы контейнера */
  className?: string;
  /** Иконки по краям (опц.) */
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;

  /** Колбэки скраба */
  onChangeStart?: (v: number) => void;
  onChange?: (v: number) => void;
  onChangeEnd?: (v: number) => void;
};

export default function ElasticSlider({
  value: valueProp,
  startingValue = 0,
  maxValue = 100,
  defaultValue = 0,
  isStepped = false,
  stepSize = 1,
  className = "",
  leftIcon = <></>,
  rightIcon = <></>,
  onChangeStart,
  onChange,
  onChangeEnd,
}: ElasticSliderProps) {
  // управляемый/неуправляемый режим
  const [internal, setInternal] = useState<number>(defaultValue);
  const isControlled = typeof valueProp === "number";
  const value = isControlled ? (valueProp as number) : internal;

  const sliderRef = useRef<HTMLDivElement>(null);
  const [region, setRegion] = useState<"left" | "middle" | "right">("middle");
  const clientX = useMotionValue(0);
  const overflow = useMotionValue(0);
  const scale = useMotionValue(1);

  useEffect(() => {
    if (isControlled) return;
    setInternal(defaultValue);
  }, [defaultValue, isControlled]);

  useMotionValueEvent(clientX, "change", (latest: number) => {
    if (sliderRef.current) {
      const { left, right } = sliderRef.current.getBoundingClientRect();
      let newValue: number;
      if (latest < left) {
        setRegion("left");
        newValue = left - latest;
      } else if (latest > right) {
        setRegion("right");
        newValue = latest - right;
      } else {
        setRegion("middle");
        newValue = 0;
      }
      overflow.jump(decay(newValue, MAX_OVERFLOW));
    }
  });

  const clamp = (v: number) => Math.min(Math.max(v, startingValue), maxValue);

  const calcFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!sliderRef.current) return value;
    const { left, width } = sliderRef.current.getBoundingClientRect();
    let v = startingValue + ((e.clientX - left) / width) * (maxValue - startingValue);
    if (isStepped && stepSize > 0) v = Math.round(v / stepSize) * stepSize;
    return clamp(v);
  };

  const setVal = (v: number, trigger: "move" | "end" | "start") => {
    if (!isControlled) setInternal(v);
    if (trigger === "move") onChange?.(v);
    if (trigger === "end") onChangeEnd?.(v);
    if (trigger === "start") onChangeStart?.(v);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons > 0) {
      const v = calcFromPointer(e);
      clientX.jump(e.clientX);
      setVal(v, "move");
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const v = calcFromPointer(e);
    clientX.jump(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    setVal(v, "start");
  };

  const handlePointerUp = () => {
    animate(overflow, 0, { type: "spring", bounce: 0.5 });
    setVal(value, "end");
  };

  const rangePercent = (() => {
    const total = maxValue - startingValue;
    return total === 0 ? 0 : ((value - startingValue) / total) * 100;
  })();

  return (
    <div className={`flex w-full items-center justify-center gap-3 ${className}`}>
      <motion.div
        onHoverStart={() => animate(scale, 1.15)}
        onHoverEnd={() => animate(scale, 1)}
        onTouchStart={() => animate(scale, 1.15)}
        onTouchEnd={() => animate(scale, 1)}
        style={{ scale, opacity: useTransform(scale, [1, 1.15], [0.7, 1]) }}
        className="flex w-full touch-none select-none items-center justify-center gap-4"
      >
        <motion.div
          animate={{ scale: region === "left" ? [1, 1.35, 1] : 1, transition: { duration: 0.25 } }}
          style={{ x: useTransform(() => (region === "left" ? -overflow.get() / scale.get() : 0)) }}
        >
          {leftIcon}
        </motion.div>

        <div
          ref={sliderRef}
          className="relative flex w-full flex-grow cursor-grab touch-none select-none items-center py-3"
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
        >
          <motion.div
            style={{
              scaleX: useTransform(() => {
                if (sliderRef.current) {
                  const { width } = sliderRef.current.getBoundingClientRect();
                  return 1 + overflow.get() / width;
                }
                return 1;
              }),
              scaleY: useTransform(overflow, [0, MAX_OVERFLOW], [1, 0.85]),
              transformOrigin: useTransform(() => {
                if (sliderRef.current) {
                  const { left, width } = sliderRef.current.getBoundingClientRect();
                  return clientX.get() < left + width / 2 ? "right" : "left";
                }
                return "center";
              }),
              height: useTransform(scale, [1, 1.15], [6, 10]),
              marginTop: useTransform(scale, [1, 1.15], [0, -2]),
              marginBottom: useTransform(scale, [1, 1.15], [0, -2]),
            }}
            className="flex flex-grow"
          >
            <div className="relative h-full flex-grow overflow-hidden rounded-full bg-white/15">
              <div
                className="absolute h-full rounded-full bg-white/50"
                style={{ width: `${rangePercent}%` }}
              />
            </div>
          </motion.div>
        </div>

        <motion.div
          animate={{ scale: region === "right" ? [1, 1.35, 1] : 1, transition: { duration: 0.25 } }}
          style={{ x: useTransform(() => (region === "right" ? overflow.get() / scale.get() : 0)) }}
        >
          {rightIcon}
        </motion.div>
      </motion.div>
    </div>
  );
}

function decay(value: number, max: number): number {
  if (max === 0) return 0;
  const entry = value / max;
  const sigmoid = 2 * (1 / (1 + Math.exp(-entry)) - 0.5);
  return sigmoid * max;
}