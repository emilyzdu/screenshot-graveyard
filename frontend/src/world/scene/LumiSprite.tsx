import { forwardRef } from 'react';
import { assetUrl } from '../assets';

/** Position, facing and frame are written straight to the element by the scene loop. */
export const LumiSprite = forwardRef<HTMLDivElement>(function LumiSprite(_props, ref) {
  return (
    <div ref={ref} className="pw-lumi" data-facing="down" data-state="idle" data-testid="lumi" role="img" aria-label="Lumi, the lantern ghost" style={{ ['--pw-lumi' as string]: `url(${assetUrl('lumi-sheet')})` }}>
      <img className="pw-lumi__glow" src={assetUrl('glow-lumi')} alt="" />
      <span className="pw-lumi__body" />
    </div>
  );
});
