import Deployments from './components/Deployments.jsx';
import Monitoring from './components/Monitoring.jsx';
import SignIn from './components/SignIn.jsx';
import SystemStatus from './components/SystemStatus.jsx';
import { useAuth } from './hooks/useAuth.js';

function Header({ user, onSignOut }) {
  return (
    <header className="page__header">
      <div>
        <h1>DeployX</h1>
        <p className="page__tagline">Self-Service Deployment Platform</p>
      </div>
      {user && (
        <div className="account">
          <span className="account__name">{user.name}</span>
          <span className={`tag tag--role tag--${user.role.toLowerCase()}`}>{user.role}</span>
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

// Signed out: only the sign-in form (and the public system status). What a
// signed-in user can reach is decided by the API on every request.
export default function App() {
  const auth = useAuth();

  if (auth.status !== 'signed-in') {
    return (
      <main className="page">
        <Header />
        <SystemStatus />
        {auth.status === 'loading' && <p className="muted">Checking your session…</p>}
        {auth.status === 'error' && (
          <p className="notice notice--error">
            Could not reach the API: {auth.error}{' '}
            <button type="button" className="link-button" onClick={auth.retry}>
              Try again
            </button>
          </p>
        )}
        {auth.status === 'signed-out' && <SignIn onSignedIn={auth.setUser} />}
      </main>
    );
  }

  return (
    <main className="page">
      <Header user={auth.user} onSignOut={auth.signOut} />
      <SystemStatus />
      <Monitoring />
      <Deployments />
    </main>
  );
}
