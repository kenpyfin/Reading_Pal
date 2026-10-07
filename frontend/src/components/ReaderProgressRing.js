import React from 'react';

export default function ReaderProgressRing({ fraction, caption, accessibleName }) {
  const size = 28;
  const stroke = 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(1, Math.max(0, fraction));
  const dash = circumference * clamped;
  const center = size / 2;

  return (
    <span className="reader-progress">
      <svg
        className="reader-progress-ring"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={accessibleName}
      >
        <circle
          className="reader-progress-track"
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
          fill="none"
        />
        <circle
          className="reader-progress-arc"
          cx={center}
          cy={center}
          r={radius}
          strokeWidth={stroke}
          fill="none"
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${center} ${center})`}
        />
      </svg>
      <span className="reader-progress-caption">{caption}</span>
    </span>
  );
}
