'use client';

import { cn } from '@monad/ui';

type OverviewIllustrationVariant = 'runtime' | 'mesh';

function RuntimeIllustration() {
  return (
    <svg
      aria-hidden="true"
      className="studio-overview-illustration__svg"
      viewBox="0 0 240 156"
    >
      <g className="studio-assembly-tray">
        <path d="M25 18h58M25 138h88" />
        <circle
          cx="86"
          cy="72"
          r="3"
        />
      </g>
      <g className="studio-assembly-agent">
        <rect
          height="78"
          rx="22"
          width="94"
          x="118"
          y="39"
        />
        <circle
          cx="151"
          cy="75"
          r="4"
        />
        <circle
          cx="179"
          cy="75"
          r="4"
        />
        <path d="M149 92h32" />
      </g>
      <g className="studio-assembly-dock studio-assembly-dock--top">
        <rect
          height="20"
          rx="7"
          width="38"
          x="146"
          y="42"
        />
        <path d="M157 52h16" />
      </g>
      <g className="studio-assembly-dock studio-assembly-dock--right">
        <rect
          height="28"
          rx="9"
          width="30"
          x="179"
          y="67"
        />
        <path d="M189 76h10M194 71v10" />
      </g>
      <g className="studio-assembly-dock studio-assembly-dock--bottom">
        <rect
          height="20"
          rx="7"
          width="38"
          x="146"
          y="96"
        />
        <path d="M156 106h18" />
      </g>
      <g className="studio-assembly-dock studio-assembly-dock--left">
        <rect
          height="28"
          rx="9"
          width="30"
          x="121"
          y="67"
        />
        <path d="M131 81h10" />
      </g>

      <g className="studio-assembly-part studio-assembly-part--model">
        <rect
          height="30"
          rx="10"
          width="46"
          x="30"
          y="20"
        />
        <path d="M43 35h20" />
      </g>
      <g className="studio-assembly-part studio-assembly-part--tool">
        <rect
          height="30"
          rx="10"
          width="46"
          x="30"
          y="57"
        />
        <path d="M45 72h16M53 64v16" />
      </g>
      <g className="studio-assembly-part studio-assembly-part--memory">
        <rect
          height="30"
          rx="10"
          width="46"
          x="30"
          y="94"
        />
        <path d="M43 107h20M43 115h13" />
      </g>
      <g className="studio-assembly-part studio-assembly-part--policy">
        <rect
          height="30"
          rx="10"
          width="46"
          x="77"
          y="57"
        />
        <path d="M91 73l8 7 13-17" />
      </g>
      <path
        className="studio-assembly-guide"
        d="M86 72C104 72 113 78 121 81"
      />
    </svg>
  );
}

function MeshIllustration() {
  return (
    <svg
      aria-hidden="true"
      className="studio-overview-illustration__svg"
      viewBox="0 0 240 156"
    >
      <rect
        className="studio-mesh-room"
        height="100"
        rx="24"
        width="140"
        x="74"
        y="28"
      />
      <path
        className="studio-mesh-room-line"
        d="M97 108h94"
      />
      <g className="studio-mesh-entry-paths">
        <path d="M75 41C91 39 97 47 111 59" />
        <path d="M187 38C170 40 164 49 157 61" />
        <path d="M78 117C92 111 98 102 112 92" />
        <path d="M189 120C174 113 165 102 156 92" />
      </g>
      <g className="studio-mesh-agent studio-mesh-agent--one">
        <rect
          height="34"
          rx="11"
          width="50"
          x="25"
          y="24"
        />
        <circle
          cx="41"
          cy="41"
          r="3"
        />
        <path d="M52 41h12" />
      </g>
      <g className="studio-mesh-agent studio-mesh-agent--two">
        <rect
          height="34"
          rx="11"
          width="50"
          x="163"
          y="20"
        />
        <circle
          cx="179"
          cy="37"
          r="3"
        />
        <path d="M190 37h12" />
      </g>
      <g className="studio-mesh-agent studio-mesh-agent--three">
        <rect
          height="34"
          rx="11"
          width="50"
          x="28"
          y="100"
        />
        <circle
          cx="44"
          cy="117"
          r="3"
        />
        <path d="M55 117h12" />
      </g>
      <g className="studio-mesh-agent studio-mesh-agent--four">
        <rect
          height="34"
          rx="11"
          width="50"
          x="165"
          y="103"
        />
        <circle
          cx="181"
          cy="120"
          r="3"
        />
        <path d="M192 120h12" />
      </g>
      <g className="studio-mesh-space-mark">
        <rect
          height="34"
          rx="12"
          width="56"
          x="116"
          y="61"
        />
        <path d="M130 77h28M136 85h16" />
      </g>
    </svg>
  );
}

export function OverviewIllustration({
  className,
  variant
}: {
  className?: string;
  variant: OverviewIllustrationVariant;
}) {
  return (
    <div
      className={cn('studio-overview-illustration', className)}
      data-testid={`studio-${variant}-illustration`}
    >
      {variant === 'runtime' ? <RuntimeIllustration /> : <MeshIllustration />}
      <style>{`
        .studio-overview-illustration {
          min-height: 10.75rem;
          overflow: hidden;
          border-radius: 0.875rem;
          border: 1px solid color-mix(in srgb, var(--border) 78%, var(--info));
          background:
            radial-gradient(circle at 66% 50%, color-mix(in srgb, var(--info) 16%, transparent), transparent 58%),
            color-mix(in srgb, var(--card) 94%, var(--info));
          contain: content;
        }

        .studio-overview-illustration__svg {
          display: block;
          width: 100%;
          height: 100%;
          min-height: 10.75rem;
        }

        .studio-assembly-agent rect,
        .studio-mesh-space-mark rect {
          fill: color-mix(in srgb, var(--info) 16%, var(--background));
          stroke: color-mix(in srgb, var(--info) 44%, var(--border));
          stroke-width: 1.2;
        }

        .studio-assembly-agent path,
        .studio-assembly-agent circle,
        .studio-mesh-space-mark path {
          fill: none;
          stroke: color-mix(in srgb, var(--foreground) 70%, var(--info));
          stroke-linecap: round;
          stroke-width: 1.8;
        }

        .studio-assembly-agent circle {
          fill: color-mix(in srgb, var(--info) 28%, var(--background));
        }

        .studio-assembly-tray path {
          fill: none;
          stroke: color-mix(in srgb, var(--info) 28%, var(--border));
          stroke-linecap: round;
          stroke-width: 1.1;
        }

        .studio-assembly-tray circle {
          fill: color-mix(in srgb, var(--info) 32%, var(--background));
          opacity: 0.7;
        }

        .studio-assembly-part rect,
        .studio-assembly-dock rect,
        .studio-mesh-agent rect {
          fill: color-mix(in srgb, var(--background) 82%, var(--info));
          stroke: color-mix(in srgb, var(--border) 82%, var(--info));
          stroke-width: 1;
        }

        .studio-assembly-part path,
        .studio-assembly-dock path,
        .studio-mesh-agent path,
        .studio-mesh-agent circle {
          fill: none;
          stroke: color-mix(in srgb, var(--foreground) 62%, var(--info));
          stroke-linecap: round;
          stroke-width: 1.65;
        }

        .studio-mesh-agent circle {
          fill: color-mix(in srgb, var(--info) 26%, var(--background));
        }

        .studio-assembly-agent {
          transform-origin: 165px 78px;
          animation: studio-assembly-agent 5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        .studio-assembly-dock {
          opacity: 0.62;
          transform-origin: 165px 78px;
          animation: studio-assembly-dock 5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        .studio-assembly-part {
          transform-origin: center;
          animation: studio-assembly-part 5s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        .studio-assembly-part--model { --assemble-x: 119px; --assemble-y: 22px; }
        .studio-assembly-part--tool { --assemble-x: 149px; --assemble-y: 20px; }
        .studio-assembly-part--memory { --assemble-x: 119px; --assemble-y: -8px; }
        .studio-assembly-part--policy { --assemble-x: 75px; --assemble-y: 16px; }

        .studio-assembly-guide {
          fill: none;
          stroke: color-mix(in srgb, var(--info) 34%, var(--border));
          stroke-dasharray: 4 7;
          stroke-linecap: round;
          stroke-width: 1.3;
          animation: studio-assembly-guide 5s ease-out infinite;
        }

        .studio-mesh-room {
          fill: color-mix(in srgb, var(--info) 9%, var(--background));
          stroke: color-mix(in srgb, var(--info) 44%, var(--border));
          stroke-width: 1.2;
          transform-origin: 144px 78px;
          animation: studio-mesh-room 5.4s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        .studio-mesh-room-line {
          fill: none;
          stroke: color-mix(in srgb, var(--info) 34%, var(--border));
          stroke-linecap: round;
          stroke-width: 1.4;
        }

        .studio-mesh-entry-paths path {
          fill: none;
          stroke: color-mix(in srgb, var(--info) 28%, var(--border));
          stroke-dasharray: 4 7;
          stroke-linecap: round;
          stroke-width: 1.2;
          animation: studio-mesh-entry-path 5.4s ease-out infinite;
        }

        .studio-mesh-agent {
          transform-origin: center;
          animation: studio-mesh-agent 5.4s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        .studio-mesh-agent--one { --mesh-x: 63px; --mesh-y: 24px; }
        .studio-mesh-agent--two { --mesh-x: -15px; --mesh-y: 28px; animation-delay: -0.25s; }
        .studio-mesh-agent--three { --mesh-x: 60px; --mesh-y: -14px; animation-delay: -0.5s; }
        .studio-mesh-agent--four { --mesh-x: -17px; --mesh-y: -17px; animation-delay: -0.75s; }

        .studio-mesh-space-mark {
          transform-origin: 144px 78px;
          animation: studio-mesh-space-mark 5.4s cubic-bezier(0.22, 1, 0.36, 1) infinite;
        }

        @keyframes studio-assembly-part {
          0%, 100% {
            opacity: 0.92;
            transform: translate(0, 0) scale(1);
          }
          44%, 66% {
            opacity: 1;
            transform: translate(var(--assemble-x), var(--assemble-y)) scale(0.58);
          }
        }

        @keyframes studio-assembly-agent {
          0%, 100% { transform: scale(0.98); }
          44%, 66% { transform: scale(1.03); }
        }

        @keyframes studio-assembly-dock {
          0%, 100% { opacity: 0.26; }
          44%, 66% { opacity: 0.95; }
        }

        @keyframes studio-assembly-guide {
          0%, 100% { opacity: 0.45; stroke-dashoffset: 0; }
          44%, 66% { opacity: 0; stroke-dashoffset: -18; }
        }

        @keyframes studio-mesh-agent {
          0%, 100% {
            opacity: 0.92;
            transform: translate(0, 0) scale(1);
          }
          44%, 68% {
            opacity: 1;
            transform: translate(var(--mesh-x), var(--mesh-y)) scale(0.88);
          }
        }

        @keyframes studio-mesh-entry-path {
          0%, 100% { opacity: 0.5; stroke-dashoffset: 0; }
          44%, 68% { opacity: 0.12; stroke-dashoffset: -18; }
        }

        @keyframes studio-mesh-room {
          0%, 100% { transform: scale(0.98); }
          44%, 68% { transform: scale(1.02); }
        }

        @keyframes studio-mesh-space-mark {
          0%, 100% { opacity: 0.68; transform: scale(0.96); }
          44%, 68% { opacity: 1; transform: scale(1.02); }
        }

        @media (prefers-reduced-motion: reduce) {
          .studio-assembly-agent,
          .studio-assembly-dock,
          .studio-assembly-part,
          .studio-assembly-guide,
          .studio-mesh-room,
          .studio-mesh-entry-paths path,
          .studio-mesh-agent,
          .studio-mesh-space-mark {
            animation: none;
          }

          .studio-assembly-part {
            transform: translate(var(--assemble-x), var(--assemble-y)) scale(0.58);
          }

          .studio-assembly-dock {
            opacity: 0.95;
          }

          .studio-mesh-agent {
            transform: translate(var(--mesh-x), var(--mesh-y)) scale(0.88);
          }
        }
      `}</style>
    </div>
  );
}
