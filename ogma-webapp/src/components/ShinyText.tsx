import React from "react";

interface ShinyTextProps {
  text: string;
  disabled?: boolean;
  speed?: number;      // длительность цикла блика в секундах
  className?: string;
}

const ShinyText: React.FC<ShinyTextProps> = ({
  text,
  disabled = false,
  speed = 10,
  className = "",
}) => {
  const animationDuration = `${speed}s`;

  return (
    <>
      {!disabled && (
        <style>{`
          @keyframes ogma-shine {
            0% {
              background-position: 200% 0%;
            }
            100% {
              background-position: -200% 0%;
            }
          }
        `}</style>
      )}

      <span
        className={[
          "text-[#b5b5b5a4]",
          "bg-clip-text",
          "inline-block",
          className,
        ].join(" ")}
        style={{
          backgroundImage:
            "linear-gradient(120deg, rgba(255,255,255,0) 40%, rgba(255,255,255,1) 50%, rgba(255,255,255,0) 60%)",
          backgroundSize: "200% 100%",
          WebkitBackgroundClip: "text",
          // если disabled — без анимации, просто статичный "металлик"
          animation: disabled
            ? "none"
            : `ogma-shine ${animationDuration} linear infinite`,
        }}
      >
        {text}
      </span>
    </>
  );
};

export default ShinyText;