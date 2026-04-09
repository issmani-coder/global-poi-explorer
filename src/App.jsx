import { useState } from 'react';
import SearchBar from './components/SearchBar';
import ResultsScreen from './components/ResultsScreen';

export default function App() {
  const [selectedLocation, setSelectedLocation] = useState(null);

  return (
    <div style={{ width: '100%', height: '100%', margin: 0, padding: 0 }}>
      {/* If we haven't selected a location yet, show the Search Bar */}
      {!selectedLocation ? (
        <SearchBar onLocationSelect={(loc) => setSelectedLocation(loc)} />
      ) : (
        /* If we HAVE selected a location, show the Results Screen */
        <ResultsScreen 
            location={selectedLocation} 
            onGoBack={() => setSelectedLocation(null)} 
        />
      )}
    </div>
  );
}