import { useEffect } from 'react';
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
  { to: 'discover', label: 'Discover', icon: 'profile' },
  { to: 'signatures', label: 'Anchors', icon: 'anchor' },
  { to: 'history', label: 'History', icon: 'history' },
  { to: 'settings', label: 'Settings', icon: 'settings' },
];

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

  if (!settings.onboarded || !profile) {
    return <Onboarding onDone={() => navigate('home')} />;
  }

  const live = section === 'session';
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
      <main className="app-main" id="main">
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
      <nav className="nav" aria-label="Main">
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
