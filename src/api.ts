// Centralized API client with auth token management
import axios from 'axios';

const BASE = 'http://localhost:3001';

export const api = axios.create({ baseURL: BASE });

// Attach token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('bm_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401, clear token and redirect to login
api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401) {
      localStorage.removeItem('bm_token');
      localStorage.removeItem('bm_user');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
