// The new admin dashboard (src/newadmin/) is now the one and only admin
// dashboard. This file exists so main.jsx can render <App /> in the
// conventional Vite shape; the actual application lives in newadmin/.
export { default } from './newadmin/App.tsx';
