import Image from "next/image";

export function QlooCredit() {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        gap: 7,
        color: "var(--color-slate-dim)",
        fontSize: 12,
      }}
    >
      Taste intelligence by
      {/* The wordmark is only used in this credit, per the design notes. */}
      <Image src="/brand/qloo-wordmark.svg" alt="Qloo" width={38} height={13} unoptimized />
    </div>
  );
}

export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 600 600" aria-hidden="true">
      <path
        fill="currentColor"
        d="M300,0C134.31,0,0,134.31,0,300s134.31,300,300,300,300-134.31,300-300S465.68,0,300,0ZM300,500c-110.28,0-200-89.72-200-200s89.72-200,200-200,200,89.72,200,200-89.72,200-200,200Z"
      />
      <circle cx="300" cy="300" r="70" fill="#8c8cc8" />
    </svg>
  );
}
