/**
 * A workflow thumbnail source that may be an image OR a short video — the Tripo
 * 3D card uses a looping clip of a rotating model. Renders a muted, looped,
 * inline-autoplaying <video> for video URLs (so it reads as a lively thumbnail)
 * and a lazy <img> otherwise. Sizing/classes are identical either way, so it
 * drops in wherever a thumbnail <img> was.
 */
const VIDEO_RE = /\.(mp4|webm|mov|m4v)(\?|#|$)/i

export function isVideoThumb(url: string): boolean {
  return VIDEO_RE.test(url)
}

export function ThumbMedia({
  src,
  alt = '',
  className,
}: {
  src: string
  alt?: string
  className?: string
}) {
  if (isVideoThumb(src)) {
    return (
      <video
        src={src}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        draggable={false}
        className={className}
      />
    )
  }
  return (
    <img src={src} alt={alt} loading="lazy" decoding="async" draggable={false} className={className} />
  )
}
