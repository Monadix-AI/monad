import type { Slide } from 'yet-another-react-lightbox';

import Lightbox from 'yet-another-react-lightbox';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import './image-gallery.css';

export type ImageGallerySlide = Pick<Slide, 'alt' | 'src'>;

export type ImageGalleryLabels = {
  close: string;
  next: string;
  previous: string;
  zoomIn: string;
  zoomOut: string;
};

type ImageGalleryBaseProps = {
  index: number;
  labels: ImageGalleryLabels;
  onIndexChange?: (index: number) => void;
  slides: ImageGallerySlide[];
};

const plugins = [Zoom];

function lightboxLabels(labels: ImageGalleryLabels) {
  return {
    Close: labels.close,
    Next: labels.next,
    Previous: labels.previous,
    'Zoom in': labels.zoomIn,
    'Zoom out': labels.zoomOut
  };
}

export function ImageGalleryDialog({
  index,
  labels,
  onClose,
  onIndexChange,
  open,
  slides
}: ImageGalleryBaseProps & { onClose: () => void; open: boolean }): React.ReactElement {
  return (
    <Lightbox
      carousel={{ finite: true, imageFit: 'contain' }}
      className="monad-image-gallery"
      close={onClose}
      index={index}
      labels={lightboxLabels(labels)}
      on={{ view: ({ index: currentIndex }) => onIndexChange?.(currentIndex) }}
      open={open}
      plugins={plugins}
      slides={slides}
      styles={{
        container: {
          backdropFilter: 'blur(12px)',
          backgroundColor: 'color-mix(in srgb, var(--background) 80%, transparent)'
        }
      }}
      zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true }}
    />
  );
}
