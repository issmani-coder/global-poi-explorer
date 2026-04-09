import { useState, useEffect, useMemo, useRef } from 'react';
import { supabase } from '../supabaseClient';

// UPGRADED SLIDER STEPS (Up to 50km)
const DISTANCE_STEPS = [1, 2, 3, 5, 8, 10, 15, 20, 25, 30, 40, 50];

const GEOAPIFY_KEY = import.meta.env.VITE_GEOAPIFY_KEY;
const PEXELS_KEY = import.meta.env.VITE_PEXELS_API_KEY;
const WEATHERBIT_KEY = import.meta.env.VITE_WEATHERBIT_KEY;
const PYTHON_BACKEND_URL = 'https://global-poi-explorer.onrender.com';

const safeSetLocalStorage = (key, value) => {
  try { localStorage.setItem(key, value); } 
  catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      localStorage.clear();
      try { localStorage.setItem(key, value); } catch (e2) {}
    }
  }
};

const getWindDirection = (degree) => {
    if (degree === undefined || degree === null) return '';
    const val = Math.floor((degree / 22.5) + 0.5);
    const arr = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return arr[(val % 16)];
};

const getWeatherInfo = (code) => {
    if (code === 0) return { icon: '☀️', text: 'Clear' };
    if ([1, 2, 3].includes(code)) return { icon: '⛅', text: 'Cloudy' };
    if ([45, 48].includes(code)) return { icon: '🌫️', text: 'Foggy' };
    if ([51, 53, 55, 56, 57].includes(code)) return { icon: '🌧️', text: 'Drizzle' };
    if ([61, 63, 65, 66, 67].includes(code)) return { icon: '☔', text: 'Rain' };
    if ([71, 73, 75, 77, 85, 86].includes(code)) return { icon: '❄️', text: 'Snow' };
    if ([80, 81, 82].includes(code)) return { icon: '🚿', text: 'Showers' };
    if ([95, 96, 99].includes(code)) return { icon: '⛈️', text: 'Thunderstorm! ⚠️' };
    return { icon: '🌤️', text: 'Unknown' };
};

export default function ResultsScreen({ location, onGoBack }) {
  const [places, setPlaces] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isFullScreen, setIsFullScreen] = useState(false);
  const [apiError, setApiError] = useState(null); 
  
  const [weatherData, setWeatherData] = useState(null);
  const [hourlyWeather, setHourlyWeather] = useState(null);
  const [selectedWeatherDay, setSelectedWeatherDay] = useState(null);
  const [destinationImage, setDestinationImage] = useState(null);
  
  // Weather Alerts Structure Updated for Links
  const [weatherWarnings, setWeatherWarnings] = useState({ 
      active: false, 
      alerts: [{ title: "Fetching live alerts...", uri: null }] 
  });
  
  const [bgImages, setBgImages] = useState([]);
  const [currentBgIndex, setCurrentBgIndex] = useState(0);
  
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [activeScrapingIds, setActiveScrapingIds] = useState([]);
  const [bulkScraping, setBulkScraping] = useState({ group: null, current: 0, total: 0 });
  const cancelScrapeRef = useRef(false);

  // START AT INDEX 3 (5 km) INSTEAD OF 1 km
  const [visualRadiusIndex, setVisualRadiusIndex] = useState(3); 
  const [appliedRadiusIndex, setAppliedRadiusIndex] = useState(3); 
  
  const [minRating, setMinRating] = useState(0);
  const [sortBy, setSortBy] = useState('distance'); 
  const [activeCategories, setActiveCategories] = useState({
    Restaurants: true, Attractions: true, Hotels: true, Shopping: true, GasStations: true, Hospitals: true
  });

  const currentRadiusKm = DISTANCE_STEPS[appliedRadiusIndex];
  const visualRadiusKm = DISTANCE_STEPS[visualRadiusIndex];
  
  const cacheKey = `poiCache_${location?.lat}_${location?.lon}_${currentRadiusKm}_v28`;

  useEffect(() => {
    if (PEXELS_KEY && location?.name) {
        const coreName = location.name.split(',')[0].trim() + " city";
        fetch(`https://api.pexels.com/v1/search?query=${encodeURIComponent(coreName)}&per_page=10&orientation=landscape`, {
            headers: { Authorization: PEXELS_KEY }
        })
        .then(res => res.json())
        .then(data => {
            if (data.photos && data.photos.length > 0) {
                setBgImages(data.photos.map(img => img.src.large2x || img.src.large));
            }
        }).catch(e => console.warn("Pexels fetch failed", e));
    }
  }, [location]);

  useEffect(() => {
    if (bgImages.length <= 1) return;
    const interval = setInterval(() => {
        setCurrentBgIndex((prev) => (prev + 1) % bgImages.length);
    }, 5000);
    return () => clearInterval(interval);
  }, [bgImages]);

  useEffect(() => {
    const timer = setTimeout(() => {
        if (visualRadiusIndex !== appliedRadiusIndex) setAppliedRadiusIndex(visualRadiusIndex);
    }, 800);
    return () => clearTimeout(timer);
  }, [visualRadiusIndex, appliedRadiusIndex]);

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
    if (sourceStr === 'Google') return { name: 'Google', icon: '🔵', color: '#4285F4' };
    return { name: sourceStr, icon: '🌐', color: '#666' };
  };

  useEffect(() => {
    if (!location?.lat || !location?.lon) return;

    const fetchCityImage = async () => {
        try {
            const coreName = location.name.split(',')[0].trim(); 
            const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(coreName + ' city')}&gsrlimit=1&prop=pageimages&piprop=original&format=json&origin=*`);
            const data = await res.json();
            const pages = data.query?.pages;
            if (pages) {
                const pageId = Object.keys(pages)[0];
                if (pages[pageId].original) setDestinationImage(pages[pageId].original.source);
            }
        } catch(e) {}
    };

    const fetchWeather = async () => {
        try {
            const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum,snowfall_sum,wind_speed_10m_max,wind_direction_10m_dominant,uv_index_max,sunshine_duration,daylight_duration,precipitation_hours&hourly=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,cloud_cover,visibility,uv_index&timezone=auto`;
            const res = await fetch(weatherUrl);
            const data = await res.json();
            
            const forecast = data.daily.time.slice(0, 5).map((date, index) => ({
                dateStr: date,
                dateDisplay: new Date(date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
                maxTemp: data.daily.temperature_2m_max[index],
                minTemp: data.daily.temperature_2m_min[index],
                weatherCode: data.daily.weather_code[index],
                sunrise: new Date(data.daily.sunrise[index]).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                sunset: new Date(data.daily.sunset[index]).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}),
                rain: data.daily.precipitation_sum[index],
                snow: data.daily.snowfall_sum[index],
                precipHours: data.daily.precipitation_hours[index],
                wind: data.daily.wind_speed_10m_max[index],
                windDir: getWindDirection(data.daily.wind_direction_10m_dominant[index]),
                uv: data.daily.uv_index_max[index],
                sunshine: (data.daily.sunshine_duration[index] / 3600).toFixed(1), 
                daylight: (data.daily.daylight_duration[index] / 3600).toFixed(1) 
            }));
            
            setWeatherData(forecast);
            setHourlyWeather(data.hourly);
        } catch(e) { console.warn("Weather fetch failed", e); }
    };

    const fetchLiveAlerts = async () => {
        if (!WEATHERBIT_KEY) return;
        try {
            const alertUrl = `https://api.weatherbit.io/v2.0/alerts?lat=${location.lat}&lon=${location.lon}&key=${WEATHERBIT_KEY}`;
            const res = await fetch(alertUrl);
            if (res.ok) {
                const data = await res.json();
                if (data.alerts && data.alerts.length > 0) {
                    
                    // Map over alerts to pull title and link. If no link exists, generate a Google Search URL.
                    const mappedAlerts = data.alerts.map(a => ({
                        title: a.title,
                        uri: a.uri || `https://www.google.com/search?q=${encodeURIComponent(a.title + ' weather alert ' + location.name)}`
                    }));
                    
                    // Remove duplicates by title so we don't spam the UI
                    const uniqueAlerts = Array.from(new Map(mappedAlerts.map(item => [item.title, item])).values());
                    
                    setWeatherWarnings({ active: true, alerts: uniqueAlerts });
                } else {
                    setWeatherWarnings({ active: false, alerts: [{ title: "No active severe weather warnings for this location.", uri: null }] });
                }
            } else {
                setWeatherWarnings({ active: false, alerts: [{ title: "Unable to fetch live alerts at this time.", uri: null }] });
            }
        } catch(e) { 
            console.warn("Weatherbit fetch failed", e); 
            setWeatherWarnings({ active: false, alerts: [{ title: "Live alert server unreachable.", uri: null }] });
        }
    };

    fetchCityImage();
    fetchWeather();
    fetchLiveAlerts();
  }, [location]);

  const zipCode = location?.address?.postcode || '';
  const locationDetails = zipCode ? `${location.name} (Zip: ${zipCode})` : location?.name;

  const handleDayClick = (dayIndex) => {
      setSelectedWeatherDay(selectedWeatherDay === dayIndex ? null : dayIndex);
  };

  const renderHourlyForecast = () => {
      if (selectedWeatherDay === null || !hourlyWeather) return null;
      
      const targetDate = weatherData[selectedWeatherDay].dateStr;
      const startIndex = hourlyWeather.time.findIndex(t => t.startsWith(targetDate));
      if (startIndex === -1) return null;

      let actualStartIndex = startIndex;
      if (selectedWeatherDay === 0) {
          const currentHourStr = new Date().toISOString().slice(0, 13) + ":00"; 
          const todayNowIndex = hourlyWeather.time.findIndex(t => t === currentHourStr);
          if (todayNowIndex !== -1) actualStartIndex = todayNowIndex;
      } else {
          actualStartIndex = startIndex + 8; 
      }

      const hours = [];
      for (let i = actualStartIndex; i < actualStartIndex + 10; i++) {
          if (i >= hourlyWeather.time.length) break;
          const timeLabel = new Date(hourlyWeather.time[i]).toLocaleTimeString([], {hour: 'numeric', minute:'2-digit'});
          const wInfo = getWeatherInfo(hourlyWeather.weather_code[i]);
          
          hours.push(
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: '95px', padding: '10px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #eee' }}>
                  <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#666' }}>{timeLabel}</span>
                  <span style={{ fontSize: '18px', margin: '5px 0' }} title={wInfo.text}>{wInfo.icon}</span>
                  <span style={{ fontSize: '13px', fontWeight: 'bold' }}>{hourlyWeather.temperature_2m[i]}°C</span>
                  <div style={{ fontSize: '10px', color: '#666', marginTop: '6px', textAlign: 'center', lineHeight: '1.4' }}>
                      💨 {hourlyWeather.wind_speed_10m[i]}km/h {getWindDirection(hourlyWeather.wind_direction_10m[i])}
                      <br/>💧 {hourlyWeather.precipitation[i]}mm precip
                      <br/>☁️ {hourlyWeather.cloud_cover[i]}% cloud
                      <br/>👁️ {(hourlyWeather.visibility[i] / 1000).toFixed(1)}km vis
                      <br/>☀️ {hourlyWeather.uv_index[i]} UV
                  </div>
              </div>
          );
      }

      return (
          <div style={{ marginTop: '10px', padding: '15px', backgroundColor: '#e9ecef', borderRadius: '8px', display: 'flex', gap: '10px', overflowX: 'auto', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', paddingRight: '15px', borderRight: '2px solid #ccc', color: '#555', fontWeight: 'bold', fontSize: '12px', whiteSpace: 'nowrap' }}>
                  10-Hour<br/>Outlook
              </div>
              {hours}
          </div>
      );
  };

  useEffect(() => {
    let isMounted = true;
    const fetchPOIs = async () => {
      setApiError(null);
      setPlaces([]); 
      
      if (!location || isNaN(parseFloat(location.lat)) || isNaN(parseFloat(location.lon))) {
          setApiError("Invalid coordinates. Please go back and select a location.");
          return;
      }
      let validLat = parseFloat(location.lat); let validLon = parseFloat(location.lon);
      if (validLat < -90 || validLat > 90) { const temp = validLat; validLat = validLon; validLon = temp; }

      try {
        const cachedData = localStorage.getItem(cacheKey);
        if (cachedData) {
          const parsed = JSON.parse(cachedData);
          if (parsed.length > 0 && isMounted) { setPlaces(parsed); return; }
        }
      } catch (e) {}
      
      setIsLoading(true); setProgress(15);
      const progressInterval = setInterval(() => { if (isMounted) setProgress((prev) => (prev < 85 ? prev + 15 : prev)); }, 300);
      
      try {
        const radiusMeters = currentRadiusKm * 1000;
        const targetCategories = 'accommodation,catering,commercial,healthcare,service,tourism,entertainment';
        const url = `https://api.geoapify.com/v2/places?categories=${targetCategories}&filter=circle:${validLon},${validLat},${radiusMeters}&bias=proximity:${validLon},${validLat}&limit=500&apiKey=${GEOAPIFY_KEY}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Geoapify blocked the request: ${response.status}`);
        
        const data = await response.json();
        clearInterval(progressInterval);
        if (isMounted) setProgress(100);
        
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
              id: id, pLat: props.lat, pLon: props.lon, distance: props.distance / 1000,
              rating: null, reviews: null, photoUrl: `https://picsum.photos/seed/${id}/400/200`,
              group: uiDesign.group, icon: uiDesign.icon, label: uiDesign.label,
              tags: { name: props.name }, needsRealData: true, description: props.formatted,
              source: null, isError: false
            });
        });
          
        const finalPlaces = processedPlaces.filter(p => p.group !== 'Other');

        if (finalPlaces.length > 0) {
            const placeIds = finalPlaces.map(p => p.id);
            const { data: dbCache } = await supabase.from('poi_data').select('*').in('place_id', placeIds);

            if (dbCache && dbCache.length > 0) {
                finalPlaces.forEach(place => {
                    const cachedMatch = dbCache.find(db => db.place_id === place.id);
                    if (cachedMatch) {
                        place.rating = cachedMatch.rating;
                        place.reviews = cachedMatch.reviews;
                        if (cachedMatch.photo_ref) place.photoUrl = `${PYTHON_BACKEND_URL}/get_image?ref=${cachedMatch.photo_ref}`;
                        if (cachedMatch.description) place.description = cachedMatch.description;
                        place.source = cachedMatch.source;
                        place.needsRealData = false; 
                    }
                });
            }
        }

        if (isMounted) {
            setPlaces(finalPlaces); 
            if (finalPlaces.length === 0) setApiError("No places found in this area. Try increasing the radius.");
            else safeSetLocalStorage(cacheKey, JSON.stringify(finalPlaces));
        }
      } catch (error) {
        clearInterval(progressInterval); 
        if (isMounted) { setProgress(100); setApiError(error.message); }
      }
      setTimeout(() => { if (isMounted) setIsLoading(false); }, 400); 
    };
    
    fetchPOIs();
    return () => { isMounted = false; };
  }, [location, appliedRadiusIndex]); 

  const saveToMemory = (updatedPlaces) => {
      if (updatedPlaces.length > 0 && !apiError) safeSetLocalStorage(cacheKey, JSON.stringify(updatedPlaces));
  };

  const fetchRealDataForPlace = async (placeId, placeName, category) => {
    setActiveScrapingIds(prev => [...prev, placeId]); 
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000); 

    try {
      const response = await fetch(`${PYTHON_BACKEND_URL}/get_details?name=${encodeURIComponent(placeName)}&location=${encodeURIComponent(location?.name || '')}&category=${encodeURIComponent(category)}`, { signal: controller.signal });
      clearTimeout(timeoutId); 

      if (response.ok) {
        const realData = await response.json();
        let finalImageUrl = null;
        if (realData.scraped_photo_ref) finalImageUrl = `${PYTHON_BACKEND_URL}/get_image?ref=${realData.scraped_photo_ref}`;

        if (!realData.error) {
            await supabase.from('poi_data').upsert({
                place_id: placeId,
                name: placeName,
                category: category,
                rating: realData.scraped_rating,
                reviews: realData.scraped_reviews,
                photo_ref: realData.scraped_photo_ref,
                description: realData.scraped_description,
                source: realData.source,
                updated_at: new Date()
            });
        }

        setPlaces(prevPlaces => {
            const newPlaces = prevPlaces.map(p => {
              if (p.id === placeId) {
                return { 
                    ...p, rating: realData.error ? "Error" : realData.scraped_rating, 
                    reviews: realData.scraped_reviews, photoUrl: finalImageUrl || p.photoUrl, 
                    description: realData.error ? realData.error : (realData.scraped_description || p.description), 
                    source: realData.error ? null : realData.source, isError: !!realData.error, needsRealData: false 
                };
              }
              return p;
            });
            saveToMemory(newPlaces); 
            return newPlaces;
        });
      }
    } catch (err) { 
        setPlaces(prev => prev.map(p => p.id === placeId ? {...p, rating: "Error", isError: true, description: "Network Timeout. Server unavailable.", needsRealData: false} : p));
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
      <div key={place.id} style={{ backgroundColor: 'white', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 2px 5px rgba(0,0,0,0.05)', marginBottom: '15px', display: 'flex', flexDirection: 'column' }} >
        <div style={{ position: 'relative' }}>
            <img src={place.photoUrl} alt="Location" style={{ width: '100%', height: '120px', objectFit: 'cover' }} />
            {place.needsRealData && !isScrapingThis && ( <button onClick={() => fetchRealDataForPlace(place.id, place.tags.name, place.group)} style={{ position: 'absolute', top: '5px', right: '5px', fontSize: '11px', padding: '5px 8px', backgroundColor: 'rgba(0,0,0,0.7)', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold'}}>🔄 Load Real Data</button> )}
            {!place.needsRealData && !isScrapingThis && ( <button onClick={() => fetchRealDataForPlace(place.id, place.tags.name, place.group)} title="Refresh Data" style={{ position: 'absolute', top: '5px', right: '5px', fontSize: '12px', padding: '4px 6px', backgroundColor: 'rgba(255,255,255,0.9)', color: '#333', border: '1px solid #ccc', borderRadius: '4px', cursor: 'pointer'}}>↻</button> )}
            {isScrapingThis && ( <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.75)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', color: 'white', zIndex: 10 }}> <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Fetching Web...</span> </div> )}
        </div>
        
        <div style={{ padding: '15px', display: 'flex', flexDirection: 'column', flex: 1 }}>
          <h4 style={{ margin: '0 0 5px 0', color: '#333', fontSize: '16px' }}>{place.tags.name}</h4>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', color: '#666', marginBottom: '10px' }}> 
            <span>{place.isError ? <span style={{color: '#d32323', fontWeight: 'bold'}}>⚠️ Fetch Failed</span> : place.rating && place.rating !== "N/A" ? `⭐ ${place.rating} (${place.reviews})` : '⭐ No rating yet'}</span> 
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
                                <span>Fetching {bulkScraping.current} of {bulkScraping.total}...</span>
                                <button onClick={cancelBulkScrape} style={{ fontSize: '10px', padding: '2px 5px', backgroundColor: '#ff6b6b', color: 'white', border: 'none', borderRadius: '3px', cursor: 'pointer' }}>⏹️ Stop</button>
                            </div>
                        </div>
                    ) : itemsNeedingData > 0 ? (
                        <button onClick={() => fetchRealDataForCategory(group)} style={{ fontSize: '11px', padding: '6px 10px', backgroundColor: '#f8f9fa', color: '#333', border: '1px solid #ced4da', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', width: '100%' }}>
                            ⬇️ Bulk Fetch {itemsNeedingData} Places
                        </button>
                    ) : (
                        <span style={{ fontSize: '12px', color: '#2b8a3e', fontWeight: 'bold', display: 'block', padding: '6px 0' }}>✅ Fully Fetched</span>
                    )}
                </div>
            )}
        </div>
    );
  };

  const fallbackBg = 'https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=1600&q=80';
  
  const wrapperStyle = {
      position: 'fixed', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'center',
      zIndex: 1, margin: 0, padding: 0, overflow: 'hidden'
  };

  const containerStyle = isFullScreen 
    ? { position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(248, 249, 250, 0.97)', padding: '20px', width: '100vw', height: '100vh', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' } 
    : { backgroundColor: 'rgba(248, 249, 250, 0.97)', padding: '20px', borderRadius: '15px', boxShadow: '0 10px 40px rgba(0,0,0,0.5)', width: '95%', maxWidth: '1600px', height: '95vh', fontFamily: 'sans-serif', display: 'flex', flexDirection: 'column', boxSizing: 'border-box', position: 'relative', zIndex: 10 };

  return (
    <div style={wrapperStyle}>
      {bgImages.length > 0 ? bgImages.map((img, i) => (
          <div key={img} style={{ position: 'absolute', inset: 0, backgroundImage: `url(${img})`, backgroundSize: 'cover', backgroundPosition: 'center', opacity: currentBgIndex === i ? 1 : 0, transition: 'opacity 1.5s ease-in-out', zIndex: -2 }} />
      )) : ( <div style={{ position: 'absolute', inset: 0, backgroundImage: `url(${fallbackBg})`, backgroundSize: 'cover', backgroundPosition: 'center', zIndex: -2 }} /> )}

      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(30, 40, 50, 0.6)', zIndex: -1 }}></div>
      
      <div style={containerStyle}>
        {apiError && ( <div style={{ backgroundColor: '#fff3cd', color: '#856404', padding: '12px', borderRadius: '8px', marginBottom: '15px', border: '1px solid #ffeeba', textAlign: 'center', fontWeight: 'bold', fontSize: '14px' }}> ⚠️ {apiError} </div> )}
        
        <div style={{ display: 'flex', flexDirection: 'column', marginBottom: '20px', borderBottom: '2px solid #eee', paddingBottom: '15px', backgroundColor: 'white', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', flexShrink: 0 }}>
            
            <div style={{ width: '100%', height: isFullScreen ? '150px' : '100px', backgroundColor: '#e9ecef', backgroundImage: `url(${destinationImage})`, backgroundSize: 'cover', backgroundPosition: 'center', position: 'relative' }}>
                <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', padding: '20px' }}>
                    <h2 style={{ margin: 0, color: 'white', fontSize: isFullScreen ? '32px' : '24px', textShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>{locationDetails}</h2>
                    <div style={{ display: 'flex', gap: '10px' }}> 
                        <button onClick={() => setIsFullScreen(!isFullScreen)} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: '5px', fontWeight: 'bold' }}> {isFullScreen ? '🗗 Exit Full Screen' : '⛶ Full Screen'} </button> 
                        <button onClick={onGoBack} style={{ padding: '8px 15px', cursor: 'pointer', backgroundColor: 'rgba(255,255,255,0.9)', border: 'none', borderRadius: '5px', fontWeight: 'bold' }}> ← Back to Search </button> 
                    </div>
                </div>
            </div>

            {weatherData && (
                <div style={{ padding: '15px 20px', display: 'flex', flexDirection: 'column', backgroundColor: '#fff' }}>
                    <div style={{ display: 'flex', gap: '15px', overflowX: 'auto', paddingBottom: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingRight: '15px', borderRight: '2px solid #eee', color: '#555', fontWeight: 'bold' }}>
                            <span>5-Day</span><span>Forecast</span>
                        </div>
                        {weatherData.map((day, i) => {
                            const info = getWeatherInfo(day.weatherCode);
                            const isSelected = selectedWeatherDay === i;
                            return (
                                <div key={i} onClick={() => handleDayClick(i)} style={{ minWidth: '180px', padding: '10px', backgroundColor: isSelected ? '#e7f5ff' : '#f8f9fa', border: isSelected ? '1px solid #339af0' : '1px solid transparent', borderRadius: '8px', display: 'flex', flexDirection: 'column', gap: '6px', cursor: 'pointer', transition: 'all 0.2s' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold', fontSize: '14px', borderBottom: '1px solid #ddd', paddingBottom: '5px' }}>
                                        <span>{day.dateDisplay}</span>
                                        <span title={info.text}>{info.icon}</span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                                        <span style={{ color: '#d9480f' }}>H: {day.maxTemp}°C</span>
                                        <span style={{ color: '#1c7ed6' }}>L: {day.minTemp}°C</span>
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#666', display: 'flex', justifyContent: 'space-between' }}>
                                        <span title="Total Precip">💧 {day.rain} mm ({day.precipHours}h)</span>
                                        <span title="Wind">💨 {day.wind} km/h {day.windDir}</span>
                                    </div>
                                    <div style={{ fontSize: '11px', color: '#666', display: 'flex', justifyContent: 'space-between' }}>
                                        <span title="Sun/Daylight">☀️ Sun: {day.sunshine}h / {day.daylight}h</span>
                                        <span title="UV Index">UV: {day.uv}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                    
                    {renderHourlyForecast()}
                    
                    {/* WEATHERBIT LIVE ALERTS UI - NOW WITH LINKS */}
                    <div style={{ marginTop: '10px', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {weatherWarnings.active ? (
                            weatherWarnings.alerts.map((alert, i) => (
                                <a key={i} href={alert.uri} target="_blank" rel="noopener noreferrer" style={{ color: '#d32323', fontWeight: 'bold', textDecoration: 'underline', display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    ⚠️ {alert.title} <span style={{fontSize: '10px'}}>↗</span>
                                </a>
                            ))
                        ) : (
                            <span style={{ color: '#2b8a3e', fontWeight: 'bold' }}>✅ {weatherWarnings.alerts[0]?.title}</span>
                        )}
                    </div>
                </div>
            )}
        </div>

        {isLoading && ( <div style={{ width: '100%', height: '5px', backgroundColor: '#e0e0e0', borderRadius: '5px', overflow: 'hidden', marginBottom: '20px', flexShrink: 0 }}> <div style={{ width: `${progress}%`, height: '100%', backgroundColor: '#007bff', transition: 'width 0.3s' }} /> </div> )}
        
        <div style={{ display: 'flex', gap: '20px', flex: 1, overflow: 'hidden' }}>
          <div style={{ width: '250px', flexShrink: 0, paddingRight: '20px', borderRight: '2px solid #eee', overflowY: 'auto' }}>
            <h3 style={{ marginTop: 0 }}>Filters</h3>
            <div style={{ marginBottom: '25px' }}> <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Search Results:</label> <input type="text" placeholder="e.g. Pizza, Museum..." value={localSearchQuery} onChange={(e) => setLocalSearchQuery(e.target.value)} style={{ width: '100%', padding: '8px', borderRadius: '5px', border: '1px solid #ccc', boxSizing: 'border-box' }} /> </div>
            <div style={{ marginBottom: '25px' }}> 
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '5px' }}>Radius: {visualRadiusKm} km</label> 
                <input type="range" min="0" max={DISTANCE_STEPS.length - 1} step="1" value={visualRadiusIndex} onChange={(e) => setVisualRadiusIndex(Number(e.target.value))} style={{ width: '100%', cursor: 'pointer' }} /> 
                {places.length === 500 && ( <div style={{ fontSize: '11px', color: '#e03131', marginTop: '5px', fontWeight: 'bold', textAlign: 'center', backgroundColor: '#ffe3e3', padding: '5px', borderRadius: '4px' }}> ⚠️ API Limit: Max 500 places reached. </div> )}
            </div>
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
    </div>
  );
}