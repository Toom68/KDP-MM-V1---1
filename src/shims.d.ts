declare module 'react-dom/client' {
  export const createRoot: any;
}

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
}
