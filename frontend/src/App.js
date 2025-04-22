import React from 'react';
import './index.css'; // Assuming some global styles
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PdfUploadForm from './components/PdfUploadForm';
import BookView from './pages/BookView';

function App() {
  return (
    <div className="App">
      <Router>
        <Routes>
          <Route path="/" element={<PdfUploadForm />} />
          <Route path="/book/:bookId" element={<BookView />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
