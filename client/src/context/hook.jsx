import { useContext, createContext } from 'react';
export const MusicContext = createContext();

export const useMusic = () => {
  const context = useContext(MusicContext);
  if (!context) {
    throw new Error('useMusic must be used within MusicProvider');
  }
  return context;
};