import * as PDFJS from 'pdfjs-dist';

// Configure PDF.js worker for client-side rendering
if (typeof window !== 'undefined') {
  // Use a more direct approach to set worker source
  PDFJS.GlobalWorkerOptions.workerSrc = `/_next/static/chunks/pdf.worker.js`;
}

export default PDFJS;
