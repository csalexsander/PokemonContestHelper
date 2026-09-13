import './style.css';
import { mount } from './ui/app.ts';

const app = document.querySelector<HTMLDivElement>('#app')!;
mount(app);
