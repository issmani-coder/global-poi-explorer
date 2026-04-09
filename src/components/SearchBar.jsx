import { useState, useEffect } from 'react';

export default function SearchBar({ onSearch }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [isSearching, setIsSearching] = useState(false);

  // Your LocationIQ API Key
  const LOCATION_IQ_KEY = 'pk.7d34518cf1d5daea0e449b5aaa174cd2';

  useEffect(() => {
    // Only search if the user has typed at least 3 characters
    if (query.length < 3) {
      setSuggestions([]);
      return;
    }
    
    // Debounce: Waits 500ms after the user stops typing before calling the API
    // This prevents you from burning through your 5,000 free requests too quickly!
    const delayDebounceFn = setTimeout(async () => {
      setIsSearching(true);
      try {
        const response = await fetch(`https://us1.locationiq.com/v1/autocomplete?key=${LOCATION_IQ_KEY}&q=${encodeURIComponent(query)}&limit=5&format=json`);
        
        if (response.ok) {
          const data = await response.json();
          // LocationIQ sometimes returns an error object inside a 200 OK response if it finds nothing
          // This safely ensures we only set an array of suggestions
          setSuggestions(Array.isArray(data) ? data : []); 
        }
      } catch (error) {
        console.error("Autocomplete error:", error);
      } finally {
        setIsSearching(false);
      }
    }, 500); 

    // Cleanup function to cancel the previous timer if the user keeps typing
    return () => clearTimeout(delayDebounceFn);
  }, [query]);

  const handleSelect = (place) => {
    // 1. Clear the dropdown
    setSuggestions([]);
    
    // 2. Update the input box to show what they clicked
    const cleanName = place.display_place || place.display_name.split(',')[0];
    setQuery(cleanName);
    
    // 3. Fire the data back up to App.js so it can launch the ResultsScreen
    onSearch({
      lat: parseFloat(place.lat),
      lon: parseFloat(place.lon),
      name: cleanName 
    });
  };

  return (
    <div style={{ maxWidth: '600px', margin: '100px auto', padding: '20px', fontFamily: 'sans-serif', textAlign: 'center' }}>
      <h1>🌍 Global POI Explorer</h1>
      <p>Search any city, zip code, or address in the world.</p>
      
      <div style={{ position: 'relative', textAlign: 'left' }}>
        <input 
          type="text" 
          value={query} 
          onChange={(e) => setQuery(e.target.value)} 
          placeholder="e.g. Las Vegas, NV or 89109..." 
          style={{ width: '100%', padding: '15px', fontSize: '18px', borderRadius: '8px', border: '2px solid #ddd', boxSizing: 'border-box' }}
        />
        
        {isSearching && <div style={{ position: 'absolute', right: '15px', top: '18px', color: '#888' }}>Searching...</div>}
        
        {suggestions.length > 0 && (
          <ul style={{ position: 'absolute', top: '100%', left: 0, right: 0, backgroundColor: 'white', border: '1px solid #ddd', borderRadius: '0 0 8px 8px', listStyle: 'none', margin: 0, padding: 0, zIndex: 1000, boxShadow: '0 4px 6px rgba(0,0,0,0.1)' }}>
            {suggestions.map((place) => (
              <li 
                key={place.place_id} 
                onClick={() => handleSelect(place)}
                style={{ padding: '12px 15px', cursor: 'pointer', borderBottom: '1px solid #eee' }}
                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'}
                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
              >
                <div style={{ fontWeight: 'bold', color: '#333' }}>
                    {place.display_place || place.display_name.split(',')[0]}
                </div>
                <div style={{ fontSize: '12px', color: '#777' }}>
                    {place.display_name}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}