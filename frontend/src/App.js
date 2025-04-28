import React from 'react';
import './index.css'; // Assuming some global styles
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PdfUploadForm from './components/PdfUploadForm';
import BookView from './pages/BookView';
import BookList from './pages/BookList'; // Import the new BookList component

function App() {
  return (
    <div className="App">
      <Router>
        <Routes>
          {/* Route for the book list (homepage) */}
          <Route path="/" element={<BookList />} />
          {/* Route for uploading a new PDF */}
          <Route path="/upload" element={<PdfUploadForm />} />
          {/* Route for viewing a specific book */}
          <Route path="/book/:bookId" element={<BookView />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
