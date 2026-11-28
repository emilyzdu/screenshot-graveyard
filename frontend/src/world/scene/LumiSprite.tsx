import { forwardRef, useId } from 'react';
import { expressions, type CharacterState } from '../lumi/character';

export function LumiArt({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 110 106" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-body`} x2=".35" y2="1"><stop stopColor="#fffdf5" /><stop offset="1" stopColor="#c5a9ed" /></linearGradient>
        <linearGradient id={`${id}-hat`} x1=".04" y1=".05" x2=".75" y2="1"><stop stopColor="#ae72e2" /><stop offset=".52" stopColor="#603a9d" /><stop offset="1" stopColor="#29184e" /></linearGradient>
        <radialGradient id={`${id}-light`}><stop stopColor="#ffec9e" stopOpacity=".82" /><stop offset="1" stopColor="#ffb144" stopOpacity="0" /></radialGradient>
      </defs>
      <g stroke="#312049" strokeWidth="2" strokeLinejoin="round">
        <path d="M48 52c-7 3-13 11-15 21-2 8-8 16-17 19 8 8 21 5 29 1 4 7 13 7 18 2 13 2 22-3 25-14 5-21-16-42-40-29Z" fill={`url(#${id}-body)`} />
        <path d="M33 70c10 10 27 8 38 2l9 11c-17 11-29 13-47 6l-9-7 9-12Z" fill="#56317f" />
        <path d="M26 85c14 8 29 10 48-2" fill="none" stroke="#dcad62" />
        <path d="m46 86 2-3 1 3 4 1-4 1-1 3-1-3-4-1Z" fill="#ffdb91" stroke="none" />
        <path d="M35 55c-2 11 5 23 19 23 13 0 25-6 25-17 0-7-5-14-11-17H49Z" fill={`url(#${id}-body)`} strokeWidth="1.4" />
        <path className="pw-lumi-back" d="M40 61q16-1 36-8 2 13-13 20-16 4-23-12Z" fill="#d5b9f5" stroke="none" />
        <g className="pw-lumi-face" stroke="none">
          <g className="pw-lumi-eyes" fill="#402653"><ellipse cx="50" cy="61" rx="2.4" ry="3.6" /><ellipse cx="65" cy="60" rx="2.4" ry="3.6" /></g>
          <ellipse cx="44" cy="66" rx="3.2" ry="1.7" fill="#efadce" opacity=".9" />
          <ellipse cx="71" cy="65" rx="3.1" ry="1.7" fill="#efadce" opacity=".9" />
          <path d="M55 66q3 3 6-1" fill="none" stroke="#593667" strokeWidth="1.5" strokeLinecap="round" />
          <path className="pw-lumi-smile" d="M53 65q5 3 10-1-2 9-7 6Z" fill="#6a356d" />
          <path className="pw-lumi-worry" d="M54 69q4-5 8-1" fill="none" stroke="#593667" strokeWidth="1.5" />
        </g>
        <g className="pw-lumi-hat">
          <path d="M21 48c9-7 16-16 21-28C47 8 61 5 72 12c-12-1-18 4-15 13 2 5 5 7 12 9 15-4 25-3 27 2 4 8-13 17-35 23-17 4-45 8-50 0-2-3 3-7 10-11Z" fill={`url(#${id}-hat)`} />
          <path d="M29 48q20-13 38-15l7 5q-19 5-34 14Z" fill="#43265f" />
          <path className="pw-lumi-buckle" d="m47 41 11-6 5 6-12 6Z" fill="none" stroke="#ffcf72" strokeWidth="2.3" />
          <path d="M17 56q13 2 37-5c15-4 26-10 34-13" fill="none" stroke="#e4a4da" strokeWidth="1.4" />
          <path d="M69 13q4 4 4 8" fill="none" stroke="#d4a66b" />
          <path d="m73 18 1.5 4 4 .4-3 2.8.6 4-3.7-2.2-3.6 2.2.7-4-3-2.8 4-.4Z" fill="#ffce79" stroke="#aa7041" strokeWidth="1" />
        </g>
        <g className="pw-lumi-lantern">
          <circle className="pw-lumi-light" cx="87" cy="80" r="22" fill={`url(#${id}-light)`} stroke="none" />
          <path d="M81 72c0-9 10-10 11-1" fill="none" stroke="#d19a51" strokeWidth="3" />
          <path d="m78 74 5-5h8l6 5-2 15-4 4h-9l-4-4Z" fill="#fac163" stroke="#61314a" />
          <path d="m81 76 2 12h8l3-12Z" fill="#ffed9a" stroke="#be754f" strokeWidth="1.4" />
          <path d="M86 75v14m-10-15h22M78 90h18" fill="none" stroke="#78503e" strokeWidth="1.5" />
          <path d="M85 86c-2-3 2-4 3-7 2 2 3 5 1 7Z" fill="#fffdeb" stroke="none" />
        </g>
      </g>
    </svg>
  );
}

export const LumiSprite = forwardRef<HTMLDivElement, { expression?: CharacterState }>(function LumiSprite({ expression }, ref) {
  return (
    <div ref={ref} className="pw-lumi" data-facing="down" data-state={expression ?? 'idle'} data-testid={expression ? undefined : 'lumi'} role="img" aria-label={expression ? `Lumi, ${expression}` : 'Lumi, the lantern ghost'}>
      <LumiArt className="pw-lumi__art" />
      <span className="pw-lumi__expression" aria-hidden="true">{expression && expressions[expression]}</span>
      <span className="pw-lumi__particles" aria-hidden="true">✧ <i>·</i> ✦</span>
    </div>
  );
});
