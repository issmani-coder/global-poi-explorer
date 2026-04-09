import { useState, useEffect } from 'react';
import { supabase } from '../supabaseClient';

const LOCATIONIQ_KEY = import.meta.env.VITE_LOCATIONIQ_KEY;
const PEXELS_KEY = import.meta.env.VITE_PEXELS_API_KEY;

export default function SearchBar({ onLocationSelect }) {
    const [query, setQuery] = useState('');
    const [suggestions, setSuggestions] = useState([]);
    const [recentSearches, setRecentSearches] = useState([]);
    const [bgImage, setBgImage] = useState('');

    // 1. Fetch Global History & Pexels Background on Boot
    useEffect(() => {
        const fetchHistory = async () => {
            const { data, error } = await supabase
                .from('search_history')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(15);
            
            if (data && !error) {
                const uniqueHistory = data.filter((v, i, a) => a.findIndex(t => (t.name === v.name)) === i).slice(0, 10);
                setRecentSearches(uniqueHistory);
            } else {
                // Fallback to local storage if Supabase fails
                setRecentSearches(JSON.parse(localStorage.getItem('searchHistory') || '[]'));
            }
        };

        fetchHistory();
        
        if (PEXELS_KEY) {
            fetch(`https://api.pexels.com/v1/search?query=travel+landscape&per_page=15`, {
                headers: { Authorization: PEXELS_KEY }
            })
            .then(res => res.json())
            .then(data => {
                if (data.photos && data.photos.length > 0) {
                    const randomPhoto = data.photos[Math.floor(Math.random() * data.photos.length)];
                    setBgImage(randomPhoto.src.large2x || randomPhoto.src.large);
                }
            })
            .catch(() => setBgImage('https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=1600&q=80'));
        } else {
            setBgImage('https://images.unsplash.com/photo-1524661135-423995f22d0b?ixlib=rb-4.0.3&auto=format&fit=crop&w=1600&q=80');
        }
    }, []);

    // 2. Debounced LocationIQ Autocomplete
    useEffect(() => {
        if (!query || query.length < 3) {
            setSuggestions([]);
            return;
        }

        const delayTimer = setTimeout(async () => {
            try {
                const response = await fetch(`https://api.locationiq.com/v1/autocomplete?key=${LOCATIONIQ_KEY}&q=${encodeURIComponent(query)}&limit=5`);
                if (response.ok) {
                    const data = await response.json();
                    if (!data.error) setSuggestions(data);
                }
            } catch (error) { console.error("LocationIQ Fetch Error:", error); }
        }, 500);

        return () => clearTimeout(delayTimer);
    }, [query]);

    // 3. Handle User Selection & Push to Supabase
    const handleSelect = async (locationObj) => {
        const formattedLocation = {
            lat: locationObj.lat,
            lon: locationObj.lon,
            name: locationObj.name || locationObj.display_name?.split(',')[0] || locationObj.name, 
            address: locationObj.address || {}
        };

        // Optimistically update UI
        const updatedHistory = [formattedLocation, ...recentSearches.filter(s => s.name !== formattedLocation.name)].slice(0, 10);
        setRecentSearches(updatedHistory);
        localStorage.setItem('searchHistory', JSON.stringify(updatedHistory));
        
        // Push to Supabase quietly in the background
        await supabase.from('search_history').insert([{ 
            name: formattedLocation.name, 
            lat: formattedLocation.lat, 
            lon: formattedLocation.lon 
        }]);

        onLocationSelect(formattedLocation);
    };

    return (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', justifyContent: 'center', alignItems: 'center', backgroundImage: `url(${bgImage})`, backgroundSize: 'cover', backgroundPosition: 'center', fontFamily: 'sans-serif', margin: 0, padding: 0 }}>
            <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(30, 40, 50, 0.6)' }}></div>
            
            <div style={{ position: 'relative', zIndex: 10, backgroundColor: 'rgba(255,255,255,0.98)', padding: '40px', borderRadius: '15px', width: '90%', maxWidth: '550px', boxShadow: '0 20px 40px rgba(0,0,0,0.3)' }}>
                <h1 style={{ textAlign: 'center', margin: '0 0 10px 0', fontSize: '28px', color: '#222' }}>🌍 Global POI Explorer</h1>
                <p style={{ textAlign: 'center', color: '#666', margin: '0 0 30px 0', fontSize: '15px' }}>Search any city, zip code, or address in the world.</p>
                
                <div style={{ position: 'relative' }}>
                    <input type="text" placeholder="e.g. Las Vegas, NV or 89109..." value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: '100%', padding: '15px', fontSize: '16px', borderRadius: '8px', border: '2px solid #ddd', boxSizing: 'border-box', outline: 'none', transition: 'border-color 0.2s' }} onFocus={(e) => e.target.style.borderColor = '#007bff'} onBlur={(e) => e.target.style.borderColor = '#ddd'} />

                    {suggestions.length > 0 && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, backgroundColor: 'white', border: '1px solid #ddd', borderTop: 'none', borderRadius: '0 0 8px 8px', overflow: 'hidden', boxShadow: '0 4px 6px rgba(0,0,0,0.1)', zIndex: 20 }}>
                            {suggestions.map((item, index) => (
                                <div key={index} onClick={() => handleSelect(item)} style={{ padding: '12px 15px', cursor: 'pointer', borderBottom: index === suggestions.length - 1 ? 'none' : '1px solid #eee', fontSize: '14px', color: '#333' }} onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#f8f9fa'} onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'white'}>
                                    <strong>{item.display_name.split(',')[0]}</strong>
                                    <span style={{ color: '#888', fontSize: '12px', marginLeft: '8px' }}>{item.display_name.substring(item.display_name.indexOf(',') + 1)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {recentSearches.length > 0 && (
                    <div style={{ marginTop: '30px', borderTop: '1px solid #eee', paddingTop: '20px' }}>
                        <h4 style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#888', textTransform: 'uppercase', letterSpacing: '1px' }}>Recent Searches</h4>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                            {recentSearches.map((loc, i) => (
                                <button key={i} onClick={() => handleSelect(loc)} style={{ padding: '8px 14px', fontSize: '13px', backgroundColor: '#f1f3f5', color: '#495057', border: '1px solid #dee2e6', borderRadius: '20px', cursor: 'pointer', transition: 'all 0.2s', display: 'flex', alignItems: 'center', gap: '5px' }} onMouseOver={(e) => { e.currentTarget.style.backgroundColor = '#e9ecef'; e.currentTarget.style.borderColor = '#ced4da'; }} onMouseOut={(e) => { e.currentTarget.style.backgroundColor = '#f1f3f5'; e.currentTarget.style.borderColor = '#dee2e6'; }}>
                                    <span style={{ fontSize: '14px' }}>🕒</span> {loc.name}
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}