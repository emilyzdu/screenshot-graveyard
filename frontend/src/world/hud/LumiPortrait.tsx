import { LumiArt } from '../scene/LumiSprite';

export function LumiPortrait({ ghostCount }: { ghostCount: number }) {
  return (
    <div className="pw-portrait">
      <span className="pw-portrait__frame"><LumiArt /></span>
      <div className="pw-portrait__info">
        <p className="pw-portrait__name">Lumi</p>
        <p className="pw-portrait__sub"><strong>{ghostCount}</strong> {ghostCount === 1 ? 'ghost' : 'ghosts'} waiting</p>
      </div>
    </div>
  );
}
