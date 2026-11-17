// Stable browser entry: state, features and platform ports are assembled once.
const applicationShell = MemoKeepShell.createShell({ environment: MemoKeepShell.createBrowserEnvironment() });
const applicationPorts = applicationShell.ports;
