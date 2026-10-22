/** The already-generated real thumbnail tiles behind text. Missing derivatives never block interaction. */
export function TimelineFilmstrip({ url, width }: { url?: string; width: number }) {
  if (!url || width < 80) return null;
  return <span className="timeline-filmstrip" aria-hidden="true" data-testid="timeline-filmstrip">
    {Array.from({ length: Math.ceil(width/80) },(_,index)=><img key={index} src={url} alt="" draggable={false} decoding="async" />)}
  </span>;
}
