import { renderToStaticMarkup } from 'react-dom/server';
import { Landing } from './Landing';
import { Footer, Header } from './layout';

/**
 * The home page as static HTML, for readers that don't run JavaScript (search
 * crawlers, LLM fetchers). scripts/prerender.ts puts it inside #root in the
 * built index.html; the app replaces it when it starts.
 */
export function renderStatic(): string {
  return renderToStaticMarkup(
    <div className="app prerendered">
      <Header />
      <main className="page-home">
        <Landing />
      </main>
      <Footer />
    </div>,
  );
}
