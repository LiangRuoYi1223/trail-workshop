import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const element = document.getElementById('root');
if (!element) throw new Error('应用容器不存在');
createRoot(element).render(<React.StrictMode><App /></React.StrictMode>);
