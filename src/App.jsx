import { useState } from 'react';
import SearchBar from './components/SearchBar';
import BackgroundSlider from './components/BackgroundSlider';
import ResultsScreen from './components/ResultsScreen';

function App() {
  const [backgroundTopic, setBackgroundTopic] = useState('famous landmarks');
  const [chosenDestination, setChosenDestination] = useState(null);

  document.body.style.margin = "0";

  const handleLocationSelect = (locationData) => {
    setBackgroundTopic(locationData.name); 
    setChosenDestination(locationData);    
  };

  return (
    <div style={{ 
      position: 'relative', 
      minHeight: '100vh', 
      width: '100vw', 
      display: 'flex', 
      flexDirection: 'column', 
      alignItems: 'center', 
      justifyContent: 'center', 
      overflow: 'hidden' 
    }}>
      {/* The background now sits behind EVERYTHING */}
      <BackgroundSlider topic={backgroundTopic} />
      
      {/* Foreground Content Container */}
      <div style={{ 
        zIndex: 10, 
        width: '100%', 
        display: 'flex', 
        justifyContent: 'center', 
        padding: '20px',
        boxSizing: 'border-box'
      }}>
        {/* If a destination is chosen, show Results. If not, show the Search Bar. */}
        {chosenDestination ? (
          <ResultsScreen 
            location={chosenDestination} 
            onGoBack={() => setChosenDestination(null)} 
          />
        ) : (
          <div style={{ 
            backgroundColor: 'rgba(255, 255, 255, 0.95)', 
            padding: '30px', 
            borderRadius: '15px', 
            boxShadow: '0 10px 25px rgba(0,0,0,0.2)', 
            width: '100%', 
            maxWidth: '600px' 
          }}>
            <SearchBar onSearch={handleLocationSelect} />
          </div>
        )}
      </div>
    </div>
  );
}

export default App;