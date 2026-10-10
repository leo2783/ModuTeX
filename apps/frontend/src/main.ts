// Original ModuTeX implementation. License pending provenance review.
import { mount } from 'svelte';
import App from './App.svelte';
import './styles/base.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing application mount');
mount(App, { target });
