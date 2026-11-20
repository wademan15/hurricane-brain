import { useEffect, useRef } from 'react';
import { Button, Icon, Toast } from './ui/components/kit';
import { useServices } from './ui/state/app';
import { FitCheck } from './ui/screens/FitCheck';
import { Discover } from './ui/screens/Discover';
import { HistoryDetail, HistoryList } from './ui/screens/History';
import { Home } from './ui/screens/Home';
import { Onboarding } from './ui/screens/Onboarding';
import { Profiles } from './ui/screens/Profiles';
import { Ready } from './ui/screens/Ready';
import { ProgramDetail, ProgramList } from './ui/screens/Programs';
import { Session } from './ui/screens/Session';
import { Settings } from './ui/screens/Settings';
import { Signatures } from './ui/screens/Signatures';
import { useController, useProfile, useSettings } from './ui/state/app';
import { useRoute } from './ui/state/router';

const NAV: { to: string; label: string; icon: string }[] = [
  { to: 'home', label: 'Home', icon: 'home' },
  { to: 'programs', label: 'Programs', icon: 'programs' },
  { to: 'discover', label: 'Discover', icon: 'discover' },
  { to: 'signatures', label: 'Signatures', icon: 'anchor' },
  { to: 'history', label: 'History', icon: 'history' },
  { to: 'settings', label: 'Settings', icon: 'settings' },
];

const TITLES: Record<string, string> = {
  home: 'Home', programs: 'Programs', discover: 'Discover', signatures: 'Signatures', history: 'History', settings: 'Settings',
  ready: 'Get ready', profiles: 'People', fit: 'Fit and signal check', session: 'Session',
};
const TEXT_SIZE: Record<string, string> = { normal: '106.25%', large: '125%', larger: '150%' };

export function App() {
  const { path, navigate } = useRoute();
  const settings = useSettings();
  const profile = useProfile();
  const st = useController();
  const { controller } = useServices();
  const section = path[0] ?? 'home';
  // Reduced motion also applies to the shell (the picture has its own `motion` prop).
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const apply = () => {
      const reduced = settings.reducedMotion === 'on' || (settings.reducedMotion === 'system' && !!q?.matches);
      document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
    };
    apply();
    q?.addEventListener?.('change', apply);
    return () => q?.removeEventListener?.('change', apply);
  }, [settings.reducedMotion]);

  // Theme and text size. The root font size is a percentage of the browser's own setting.
  useEffect(() => {
    const q = window.matchMedia?.('(prefers-color-scheme: light)');
    const apply = () => {
      const light = settings.theme === 'light' || (settings.theme === 'system' && !!q?.matches);
      document.documentElement.dataset.theme = light ? 'light' : 'dark';
    };
    apply();
    q?.addEventListener?.('change', apply);
    return () => q?.removeEventListener?.('change', apply);
  }, [settings.theme]);
  useEffect(() => {
    document.documentElement.style.fontSize = TEXT_SIZE[settings.textSize] ?? TEXT_SIZE.normal;
  }, [settings.textSize]);

  // One title per screen, and focus on the new screen's heading after a route change.
  const route = path.join('/');
  const first = useRef(true);
  useEffect(() => {
    if (!settings.onboarded || !profile) return;
    // A program or a past session names its own page (its heading may arrive a moment after the
    // route changes, so the title follows the heading); the others use their section name.
    const named = (section === 'programs' || section === 'history') && !!path[1];
    const setTitle = () => {
      const heading = document.querySelector<HTMLElement>('main h1')?.textContent?.trim();
      document.title = `${named && heading ? heading : (TITLES[section] ?? 'Home')} · Hurricane Brain`;
    };
    setTitle();
    const main = named ? document.querySelector('main') : null;
    const obs = main ? new MutationObserver(setTitle) : null;
    obs?.observe(main as Element, { childList: true, subtree: true, characterData: true });
    if (first.current) {
      first.current = false;
    } else if (section !== 'session') {
      // the live screen focuses its own title
      const h = document.querySelector<HTMLElement>('main h1');
      h?.setAttribute('tabindex', '-1');
      h?.focus({ preventScroll: true });
    }
    return () => obs?.disconnect();
  }, [route, section, settings.onboarded, profile]); // eslint-disable-line react-hooks/exhaustive-deps -- `path` is derived from `route`

  if (!settings.onboarded || !profile) {
    return <Onboarding onDone={() => navigate('home')} />;
  }

  const live = section === 'session';
  // While the live screen covers the page, nothing behind it can take focus.
  const covered = live && (!!st.session || !!st.replay);
  let screen;
  switch (section) {
    case 'session':
      screen = <Session navigate={navigate} />;
      break;
    case 'ready':
      screen = <Ready navigate={navigate} />;
      break;
    case 'profiles':
      screen = <Profiles navigate={navigate} />;
      break;
    case 'fit':
      screen = <FitCheck navigate={navigate} />;
      break;
    case 'programs':
      screen = path[1] ? <ProgramDetail id={path[1]} navigate={navigate} /> : <ProgramList navigate={navigate} />;
      break;
    case 'discover':
      screen = <Discover navigate={navigate} />;
      break;
    case 'signatures':
      screen = <Signatures navigate={navigate} />;
      break;
    case 'history':
      screen = path[1] ? <HistoryDetail id={path[1]} navigate={navigate} /> : <HistoryList navigate={navigate} />;
      break;
    case 'settings':
      screen = <Settings />;
      break;
    default:
      screen = <Home navigate={navigate} />;
  }

  return (
    <div className="app">
      <button type="button" className="skip-link" inert={covered} onClick={() => document.getElementById('main')?.focus()}>Skip to content</button>
      <main className="app-main" id="main" tabIndex={-1}>
        <div className="app-main-inner">
          {st.session && !live ? (
            <div className="note" role="status">
              <div className="row split">
                <span>A session is running: {st.session.programName}.</span>
                <Button size="small" variant="primary" onClick={() => navigate('session')}>Return</Button>
              </div>
            </div>
          ) : null}
          {screen}
        </div>
      </main>
      <nav className="nav" aria-label="Main" inert={covered}>
        <div className="brand">Hurricane Brain</div>
        {NAV.map((n) => (
          <a key={n.to} href={`#/${n.to}`} aria-current={section === n.to ? 'page' : undefined}>
            <Icon name={n.icon} />
            <span>{n.label}</span>
          </a>
        ))}
      </nav>
      {st.notice && section !== 'home' && !live ? <Toast onClose={() => controller.dismissNotice()}>{st.notice}</Toast> : null}
    </div>
  );
}
