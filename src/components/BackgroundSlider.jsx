import { useState, useEffect } from 'react';

// Notice we added '{ topic }' here. This allows it to receive instructions!
export default function BackgroundSlider({ topic }) {
  const [images, setImages] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const fetchImages = async () => {
      try {
        const apiKey = import.meta.env.VITE_UNSPLASH_API_KEY;
        if (!apiKey) return;

        // We replaced the hardcoded "travel" query with your actual search topic!
        const response = await fetch(`https://api.unsplash.com/photos/random?query=${topic}&count=3&orientation=landscape&client_id=${apiKey}`);
        
        if (!response.ok) return;

        const data = await response.json();
        
        // Now, instead of just saving the picture, we save the picture AND its description
        const imageData = data.map(img => ({
          url: img.urls.regular,
          // We ask Unsplash for the exact location name. If they don't have it, we use the photographer's description.
          description: img.location?.name || img.description || img.alt_description || 'Beautiful destination'
        }));
        
        setImages(imageData);
        setCurrentIndex(0); // Reset to the first picture when a new search happens
        
      } catch (error) {
        console.error("Trouble loading background images:", error);
      }
    };

    fetchImages();
  }, [topic]); // <--- This tells the app: "Every time the topic changes, fetch new photos!"

  useEffect(() => {
    if (images.length === 0) return;
    const interval = setInterval(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % images.length);
    }, 8000); 
    return () => clearInterval(interval);
  }, [images]);

  if (images.length === 0) {
    // We changed 'absolute' to 'fixed' here to force it to cover the entire screen
    return <div style={{ position: 'fixed', inset: 0, backgroundColor: '#2d3748', zIndex: -1 }} />;
  }

  return (
    <div style={{ position: 'fixed', inset: 0, overflow: 'hidden', zIndex: -1 }}>
      {images.map((img, index) => (
        <div
          key={img.url}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage: `url(${img.url})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            transition: 'opacity 2s ease-in-out',
            opacity: index === currentIndex ? 1 : 0,
          }}
        />
      ))}
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.4)' }} />
      
      {/* This is the new label sitting in the bottom left corner! */}
      <div style={{
        position: 'absolute',
        bottom: '20px',
        left: '20px',
        color: 'white',
        backgroundColor: 'rgba(0,0,0,0.6)',
        padding: '8px 15px',
        borderRadius: '5px',
        fontSize: '14px',
        fontFamily: 'sans-serif',
        maxWidth: '500px',
        transition: 'opacity 2s ease-in-out',
      }}>
        📍 {images[currentIndex]?.description}
      </div>
    </div>
  );
}