import Deployments from './components/Deployments.jsx';
import SystemStatus from './components/SystemStatus.jsx';

export default function App() {
  return (
    <main className="page">
      <header className="page__header">
        <h1>DeployX</h1>
        <p className="page__tagline">Self-Service Deployment Platform</p>
      </header>

      <SystemStatus />
      <Deployments />
    </main>
  );
}
