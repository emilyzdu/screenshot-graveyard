import { assetUrl } from '../assets';
export function LumiPortrait({ ghostCount }: { ghostCount: number }) {
  return (
    <div className="pw-portrait">
      <span className="pw-portrait__frame"><img src={assetUrl('lumi-portrait')} alt="" width={48} height={48} /></span>
      <div className="pw-portrait__info">
        <p className="pw-portrait__name">Lumi</p>
        <div className="pw-portrait__bar" aria-hidden="true"><span style={{ width: `${Math.min(100, 20 + ghostCount * 6)}%` }} /></div>
        <p className="pw-portrait__sub"><strong>{ghostCount}</strong> {ghostCount === 1 ? 'ghost' : 'ghosts'} haunting the yard</p>
      </div>
    </div>
  );
}
