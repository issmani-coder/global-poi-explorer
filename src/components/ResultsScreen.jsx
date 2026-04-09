import { useState, useEffect, useMemo, useRef } from 'react';

const DISTANCE_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20];
const GEOAPIFY_KEY = 'b98c61769e0f409e96eeb554e64de281';

const safeSetLocalStorage = (key, value) => {
  try { localStorage.setItem(key, value); } 
  catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn("Browser memory full! Wiping old cache...");
      localStorage.clear();
      try { localStorage.setItem(key, value); } catch (e2) { console.error("Cache still full."); }
    }
  }
};

export default function ResultsScreen({ location, onGoBack }) {
  const [places, setPlaces] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [apiError, setApiError] = useState(null); 
  
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [activeScrapingIds, setActiveScrapingIds] = useState([]);
  const [bulkScraping, setBulkScraping] = useState({ group: null, current: 0, total: 0 });
  const cancelScrapeRef = useRef(false);

  const [visualRadiusIndex, setVisualRadiusIndex] = useState(0); 
  const [appliedRadiusIndex, setAppliedRadiusIndex] = useState(0); 
  const [minRating, setMinRating] = useState(0);
  const [sortBy, setSortBy] = useState('distance'); 
  const [activeCategories, setActiveCategories] = useState({
    Restaurants: true, Attractions: true, Hotels: true, Shopping: true, GasStations: true, Hospitals: true
  });

  const currentRadiusKm = DISTANCE_STEPS[appliedRadiusIndex];
  const visualRadiusKm = DISTANCE_STEPS[visualRadiusIndex];
  
  const cacheKey = `poiCache_${location?.lat}_${location?.lon}_${currentRadiusKm}_v20_geoapify`;

  const categorizePlace = (categoriesArray) => {
    if (!categoriesArray) return { group: 'Other', icon: '📍', label: 'Spot' };
    
    if (categoriesArray.some(c => c.startsWith('accommodation'))) return { group: 'Hotels', icon: '🛏️', label: 'Hotel' };
    if (categoriesArray.some(c => c.startsWith('catering'))) return { group: 'Restaurants', icon: '🍽️', label: 'Dining' };
    if (categoriesArray.some(c => c.startsWith('commercial'))) return { group: 'Shopping', icon: '🛍️', label: 'Shop' };
    if (categoriesArray.some(c => c.includes('fuel'))) return { group: 'GasStations', icon: '⛽', label: 'Gas' };
    if (categoriesArray.some(c => c.startsWith('healthcare'))) return { group: 'Hospitals', icon: '🏥', label: 'Medical' };
    if (categoriesArray.some(c => c.startsWith('tourism') || c.startsWith('entertainment'))) return { group: 'Attractions', icon: '📸', label: 'Attraction' };
    
    return { group: 'Other', icon: '📍', label: 'Spot' };
  };

  const getSourceBadge = (sourceStr) => {
    if (!sourceStr || sourceStr === "Not Found") return null;
    if (sourceStr === 'Yelp') return { name: 'Yelp', icon: '🔴', color: '#d32323' };
    if (sourceStr === 'TripAdvisor') return { name: 'TripAdvisor', icon: '🦉', color: '#00af87' };
    return { name: sourceStr, icon: '🌐', color: '#666' };
  };

  useEffect(() => {
    let isMounted = true;
    
    const fetchPOIs = async () => {
      setApiError(null);
      setPlaces([]); 
      
      // STRICT GPS SANITIZER (Prevents the NaN km bug!)
      if (!location || isNaN(parseFloat(location.lat)) || isNaN(parseFloat(location.lon))) {
          setApiError("Invalid coordinates from Search Bar. Please go back and select a location from the dropdown.");
          return;
      }

      let validLat = parseFloat(location.lat);
      let validLon = parseFloat(location.lon);

      // Auto-fix if coordinates are accidentally swapped
      if (validLat < -90 || validLat > 90) {
          const temp = validLat;
          validLat = validLon;
          validLon = temp;
      }

      try {
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
          const parsed = JSON.parse(cachedData);
          if (parsed.length > 0 && isMounted) { setPlaces(parsed); return; }
        }
      } catch (e) { console.warn("Cache read failed."); }
      
      setIsLoading(true); setProgress(15);
      const progressInterval = setInterval(() => { if (isMounted) setProgress((prev) => (prev < 85 ? prev + 15 : prev)); }, 300);
      
      try {
        const radiusMeters = currentRadiusKm * 1000;
        
        // FIXED CATEGORIES: Removed specific clinic tags so Geoapify doesn't throw 400 errors
        const targetCategories = 'accommodation,catering,commercial,healthcare,service,tourism,entertainment';
        
        const url = `https://api.geoapify.com/v2/places?categories=${targetCategories}&filter=circle:${validLon},${validLat},${radiusMeters}&bias=proximity:${validLon},${validLat}&limit=500&apiKey=${GEOAPIFY_KEY}`;

        console.log("📡 Pinging Geoapify...");
        const response = await fetch(url);
        
        if (!response.ok) {
            const errorDetails = await response.text(); 
            console.error(`Geoapify Error: ${response.status}`, errorDetails);
            throw new Error(`Geoapify blocked the request: ${response.status}`);
        }
        
        const data = await response.json();

        clearInterval(progressInterval);
        if (isMounted) setProgress(100);
        
        // DEDUPLICATOR: Prevents React from crashing when Geoapify returns the same building twice
        const uniqueIds = new Set();
        const processedPlaces = [];
        
        data.features.forEach((feature, index) => {
            if (!feature.properties.name) return; 
            
            const props = feature.properties;
            const id = props.place_id || `temp_${index}`;
            
            if (uniqueIds.has(id)) return; 
            uniqueIds.add(id);
            
            const uiDesign = categorizePlace(props.categories);
            
            processedPlaces.push({
              id: id,
              pLat: props.lat,
              pLon: props.lon,
              distance: props.distance / 1000,
              rating: null,
              reviews: null,
              photoUrl: `https://picsum.photos/seed/${id}/400/200`,
              group: uiDesign.group,
              icon: uiDesign.icon,
              label: uiDesign.label,
              tags: { name: props.name },
              needsRealData: true,
              description: props.formatted,
              source: null,
              isError: false
            });
        });
          
        const finalPlaces = processedPlaces.filter(p => p.group !== 'Other');
          
        if (isMounted) {
            setPlaces(finalPlaces); 
            if (finalPlaces.length === 0) {
                setApiError("No places found in this area. Try increasing the radius.");
            } else {
                safeSetLocalStorage(cacheKey, JSON.stringify(finalPlaces));
            }
        }
      } catch (error) {
        console.error("Fetch failed:", error);
        clearInterval(progressInterval); 
        if (isMounted) { setProgress(100); setApiError(error.message); }
      }
      setTimeout(() => { if (isMounted) setIsLoading(false); }, 400); 
    };
    
    fetchPOIs();
    return () => { isMounted = false; };
  }, [location, appliedRadiusIndex]); 

  const saveToMemory = (updatedPlaces) => {
      if (updatedPlaces.length > 0 && !apiError) {
          safeSetLocalStorage(cacheKey, JSON.stringify(updatedPlaces));
      }
  };

  const fetchRealDataForPlace = async (placeId, placeName, category) => {
    setActiveScrapingIds(prev => [...prev, placeId]); 
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); 

    try {
      const response = await fetch(`http://127.0.0.1:5000/get_details?name=${encodeURIComponent(placeName)}&location=${encodeURIComponent(location?.name || '')}&category=${encodeURIComponent(category)}`, {
          signal: controller.signal
      });
      
      clearTimeout(timeoutId); 

      if (response.ok) {
        const realData = await response.json();
        setPlaces(prevPlaces => {
            const newPlaces = prevPlaces.map(p => {
              if (p.id === placeId) {
                return { 
                    ...p, 
                    rating: realData.error ? "Error" : realData.scraped_rating, 
                    reviews: realData.scraped_reviews, 
                    photoUrl: realData.scraped_photo || p.photoUrl, 
                    description: realData.error ? realData.error : (realData.scraped_description || p.description), 
                    source: realData.error ? null : realData.source,
                    isError: !!realData.error,
                    needsRealData: false 
                };
              }
              return p;
            });
            saveToMemory(newPlaces); 
            return newPlaces;
        });
      }
    } catch (err) { 
        setPlaces(prev => prev.map(p => p.id === placeId ? {...p, rating: "Error", isError: true, description: "Network Timeout. Python server unavailable.", needsRealData: false} : p));
    } finally { 
        setActiveScrapingIds(prev => prev.filter(id => id !== placeId)); 
    }
  };

  const fetchRealDataForCategory = async (groupName) => {
      const targets = places.filter(p => p.group === groupName && p.needsRealData);
      if (targets.length === 0) return;
      cancelScrapeRef.current = false;
      setBulkScraping({ group: groupName, current: 0, total: targets.length });

      let completedCount = 0; let index = 0;
      const worker = async () => {
          while (index < targets.length && !cancelScrapeRef.current) {
              const targetIndex = index++;
              await fetchRealDataForPlace(targets[targetIndex].id, targets[targetIndex].tags.name, targets[targetIndex].group);
              if (!cancelScrapeRef.current) {
                  completedCount++;
                  setBulkScraping({ group: groupName, current: completedCount, total: targets.length });
              }
          }
      };

      const workers = Array(3).fill(0).map(() => worker()); 
      await Promise.all(workers);
      if (!cancelScrapeRef.current) setBulkScraping({ group: null, current: 0, total: 0 });
  };

  const cancelBulkScrape = () => {
      cancelScrapeRef.current = true;
      setBulkScraping({ group: null, current: 0, total: 0 });
      setActiveScrapingIds([]);
  };

  const filteredAndSortedPlaces = useMemo(() => {
    let result = places.filter(place => {
      const actualRating = place.rating === "N/A" || place.rating === "Error" || !place.rating ? 0 : parseFloat(place.rating);
      if (actualRating < minRating) return false;
      if (!activeCategories[place.group]) return false;
      
      if (localSearchQuery) {
        const lowerQuery = localSearchQuery.toLowerCase();
        if (!place.tags?.name?.toLowerCase().includes(lowerQuery) && !place.description?.toLowerCase().includes(lowerQuery)) return false;
      }
      return true;
    });
    
    result.sort((a, b) => {
      if (sortBy === 'distance') return a.distance - b.distance;
      if (sortBy === 'rating') {
          const ratingA = a.rating === "N/A" || a.rating === "Error" || !a.rating ? 0 : parseFloat(a.rating);
          const ratingB = b.rating === "N/A" || b.rating === "Error" || !b.rating ? 0 : parseFloat(b.rating);
          return ratingB - ratingA;
      }
      if (sortBy === 'popularity') {
          const revA = !a.reviews ? 0 : parseInt(a.reviews.toString().replace(/,/g, ''));
          const revB = !b.reviews ? 0 : parseInt(b.reviews.toString().replace(/,/g, ''));
          return revB - revA;
      }
      return 0;
    });
    return result;
  }, [places, minRating, sortBy, activeCategories, localSearchQuery]);

  const columns = {
    Restaurants: filteredAndSortedPlaces.filter(p => p.group === 'Restaurants'),
    Attractions: filteredAndSortedPlaces.filter(p => p.group === 'Attractions'),
    Hotels: filteredAndSortedPlaces.filter(p => p.group === 'Hotels'),
    Shopping: filteredAndSortedPlaces.filter(p => p.group === 'Shopping'),
    GasStations: filteredAndSortedPlaces.filter(p => p.group === 'GasStations'),
    Hospitals: filteredAndSortedPlaces.filter(p => p.group === 'Hospitals'),
  };

  const renderCard = (place) => {
    const mapSearchQuery = encodeURIComponent(`${place.tags.name} near ${location?.name || ''}`);
    const isScrapingThis = activeScrapingIds.includes(place.id);
    const sourceData = getSourceBadge(place.source);
    
    return (
      <div 
        key={place.id} title={place.description || "Point of Interest"} 
        style={{ backgroundColor: 'white', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 2px 5px rgba(0,0,0,0.05)', marginBottom: '15px', transition: 'transform 0.2s', display: 'flex', flexDirection: 'column' }} 
      >
        <div style={{ position: 'relative' }}>
            <img src={place.photoUrl} alt="Location" style={{ width: '100%', height: '120px', objectFit: 'cover' }} />
            {place.needsRealData && !isScrapingThis && ( <button onClick={() => fetchRealDataForPlace(place.id, place.tags.name, place.group)} style={{ position: 'absolute', top: '5px', right: '5px', fontSize: '11px', padding: '5px 8px', backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'}}>🔄 Load Real Data</button> )}
            {!place.needsRealData && !isScrapingThis && ( <button onClick={() => fetchRealDataForPlace(place.id, place.tags.name, place.group)} title="Refresh Data" style={{ position: 'absolute', top: '5px', right: '5px', fontSize: '12px', padding: '4px 6px', backgroundColor: 'rgba(255,255,255,0.9)', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer'}}>↻</button> )}
            {isScrapingThis && ( 
                <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'white', zIndex: 10 }}> 
                    <span style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '8px' }}>Scraping Web...</span> 
                </div> 
            )}
        </div>
        
        <div style={{ padding: '15px', display: 'flex', flexDirection: 'column', flex: 1 }}>
          <h4 style={{ margin: '0 0 5px 0', color: '#333', fontSize: '16px' }}>{place.tags.name}</h4>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', color: '#666', marginBottom: '10px' }}> 
            <span>{place.isError ? <span style={{color: '#d32323', fontWeight: 'bold'}}>⚠️ Scraping Failed</span> : place.rating && place.rating !== "N/A" ? `⭐ ${place.rating} (${place.reviews})` : '⭐ No rating yet'}</span> 
            <span>{place.distance.toFixed(1)} km</span> 
          </div>
          {place.description && ( <div style={{ fontSize: '11px', color: place.isError ? '#842029' : '#444', backgroundColor: place.isError ? '#ffe3e3' : '#f1f3f5', padding: '8px', borderRadius: '4px', marginBottom: '10px', fontStyle: 'italic', maxHeight: '60px', overflowY: 'auto' }}> {place.description} </div> )}
          
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', marginBottom: '15px', alignItems: 'center' }}> 
            <span style={{ fontSize: '12px', backgroundColor: '#e9ecef', padding: '3px 6px', borderRadius: '4px' }}> {place.icon} {place.label} </span> 
            {sourceData && !place.isError && ( <span style={{ fontSize: '11px', fontWeight: 'bold', color: sourceData.color, border: `1px solid ${sourceData.color}`, padding: '2px 5px', borderRadius: '4px' }}> {sourceData.icon} {sourceData.name} </span> )}
          </div>
          
          <div style={{ marginTop: 'auto' }}> 
            <a href={`https://www.google.com/maps/search/?api=1&query=${mapSearchQuery}`} target="_blank" rel="noopener noreferrer" style={{ display: 'block', textAlign: 'center', backgroundColor: '#007bff', color: 'white', textDecoration: 'none', padding: '8px', borderRadius: '5px', fontSize: '14px', fontWeight: 'bold' }}> View on Google Maps </a> 
          </div>
        </div>
      </div>
    );
  };

  const renderColumnHeader = (title, group, color) => {
    const isScrapingThisGroup = bulkScraping.group === group;
    const items = columns[group];
    const itemsNeedingData = items.filter(p => p.needsRealData).length;

    return (
        <div style={{ textAlign: 'center', borderBottom: `3px solid ${color}`, paddingBottom: '10px', margin: '0 0 15px 0' }}>
            <h3 style={{ margin: '0 0 8px 0' }}>{title} ({items.length})</h3>
            {items.length > 0 && (
                <div style={{ minHeight: '30px' }}>
                    {isScrapingThisGroup ? (
                        <div style={{ fontSize: '12px', color: '#666', fontWeight: 'bold', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                                <span>Scraping {bulkScraping.current} of {bulkScraping.total}...</span>
                                <button onClick={cancelBulkScrape} style={{ fontSize: '10px', padding: '2px 5px', backgroundColor: '#ff6b6b', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>⏹️ Stop</button>
                            </div>
                        </div>
                    ) : itemsNeedingData > 0 ? (
                        <button onClick={() => fetchRealDataForCategory(group)} style={{ fontSize: '11px', padding: '6px 10px', backgroundColor: '#f8f9fa', color: '#333', border: '1px solid #ced4da', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: '100%' }}>
                            ⬇️ Bulk Scrape {itemsNeedingData} Places
                        </button>
                    ) : (
                        <span style={{ fontSize: '12px', color: '#2b8a3e', fontWeight: 'bold', display: 'block', padding: '6px 0' }}>✅ Fully Scraped</span>
                    )}
                </div>
            )}
        </div>
    );
  };

  const containerStyle = isFullScreen ? { position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(255, 255, 255, 0.98)', padding: '20px', width: '100vw', height: '100vh', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } : { backgroundColor: 'rgba(255, 255, 255, 0.95)', padding: '20px', borderRadius: '15px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)', width: '100%', maxWidth: '1600px', fontFamily: 'sans-serif', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' };

  return (
    <div style={containerStyle}>
      {apiError && ( <div style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '12px', borderRadius: '8px', marginBottom: '15px', border: '1px solid #ffeeba', textAlign: 'center', fontWeight: 'bold', fontSize: '14px' }}> ⚠️ {apiError} </div> )}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px' }}>
        <h2 style={{ margin: 0 }}>Exploring: {location?.name || 'Unknown Location'}</h2>
        <div style={{ display: 'flex', gap: '10px' }}> <button onClick={() => setIsFullScreen(!isFullScreen)} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: '#e9ecef', border: '1px solid #ccc', borderRadius: '5px', fontWeight: 'bold' }}> {isFullScreen ? '🗗 Exit Full Screen' : '⛶ Full Screen'} </button> <button onClick={onGoBack} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: '#f0f0f0', border: '1px solid #ccc', borderRadius: '5px', fontWeight: 'bold' }}> ← Back to Search </button> </div>
      </div>
      {isLoading && ( <div style={{ width: '100%', height: '5px', backgroundColor: '#e0e0e0', borderRadius: '5px', overflow: 'hidden', marginBottom: '20px' }}> <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#007bff', transition: 'width 0.3s' }} /> </div> )}
      <div style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
        <div style={{ width: '250px', flexShrink: 0, paddingRight: '20px', borderRight: '2px solid #eee', overflowY: 'auto' }}>
          <h3 style={{ marginTop: 0 }}>Filters</h3>
          <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Search Results:</label> <input type="text" placeholder="e.g. Pizza, Museum..." value={localSearchQuery} onChange={(e) => setLocalSearchQuery(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '5px', border: '1px solid #ccc', boxSizing: 'border-box' }} /> </div>
          <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Radius: {visualRadiusKm} km</label> <input type="range" min="0" max="11" step="1" value={visualRadiusIndex} onChange={(e) => setVisualRadiusIndex(Number(e.target.value))} onMouseUp={() => setAppliedRadiusIndex(visualRadiusIndex)} onTouchEnd={() => setAppliedRadiusIndex(visualRadiusIndex)} style={{ width: '100%', cursor: 'pointer' }} /> </div>
          <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Min. Rating: {minRating} ⭐</label> <input type="range" min="0" max="5" step="0.5" value={minRating} onChange={(e) => setMinRating(Number(e.target.value))} style={{ width: '100%' }} /> </div>
          <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Sort By:</label> <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '5px', border: '1px solid #ccc' }}> <option value="distance">Distance (Nearest First)</option> <option value="rating">User Rating (High to Low)</option> <option value="popularity">Popularity (Most Reviews)</option> </select> </div>
          <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '10px' }}>Categories:</label> {Object.keys(activeCategories).map(cat => ( <label key={cat} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px', cursor: 'pointer' }}> <input type="checkbox" checked={activeCategories[cat]} onChange={() => setActiveCategories(prev => ({...prev, [cat]: !prev[cat]}))} /> {cat} </label> ))} </div>
        </div>
        <div style={{ flex: 1, display: 'flex', gap: '20px', overflowX: 'auto', overflowY: 'hidden', paddingBottom: '10px' }}>
          {activeCategories.Restaurants && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('🍽️ Restaurants', 'Restaurants', '#ff6b6b')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.Restaurants.map(renderCard)} </div> </div> )}
          {activeCategories.Attractions && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('📸 Attractions', 'Attractions', '#4dabf7')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.Attractions.map(renderCard)} </div> </div> )}
          {activeCategories.Hotels && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('🛏️ Hotels', 'Hotels', '#51cf66')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.Hotels.map(renderCard)} </div> </div> )}
          {activeCategories.Shopping && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('🛍️ Shopping', 'Shopping', '#fcc419')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.Shopping.map(renderCard)} </div> </div> )}
          {activeCategories.GasStations && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('⛽ Gas Stations', 'GasStations', '#868e96')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.GasStations.map(renderCard)} </div> </div> )}
          {activeCategories.Hospitals && ( <div style={{ minWidth: '300px', maxWidth: '300px', display: 'flex', flexDirection: 'column' }}> {renderColumnHeader('🏥 Hospitals', 'Hospitals', '#e03131')} <div style={{ overflowY: 'auto', flex: 1, paddingRight: '10px' }}> {columns.Hospitals.map(renderCard)} </div> </div> )}
        </div>
      </div>
    </div>
  );
}