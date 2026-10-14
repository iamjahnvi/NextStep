import{Routes , Route } from "react-router-dom";

import Home from "./pages/Home";
import Signup from "./pages/Signup";
import Login from "./pages/Login";
import VerifyEmail from "./pages/VerifyEmail";
import Profile from "./pages/Profile";
import MainPage from "./pages/MainPage";
import Recommendations from "./pages/Recommendations";
import ExamDetails from "./pages/ExamDetails";
import FreshnessDashboard from "./pages/FreshnessDashboard";
import ProtectedRoute from "./components/ProtectedRoute";

// NOTE: BrowserRouter + AuthProvider live in main.jsx (AuthContext needs
// router navigation for logout), so App only declares Routes here.
function App(){
  return (
      <Routes>
        <Route path="/" element={<Home />}></Route>
        <Route path="/signup" element={<Signup />}></Route>
        <Route path="/login" element={<Login />}></Route>
        <Route path="/verify-email" element={<VerifyEmail />}></Route>
        <Route path="/profile" element={<ProtectedRoute><Profile/></ProtectedRoute>}></Route>
        <Route path="/main" element={<ProtectedRoute><MainPage /></ProtectedRoute>}></Route>
        <Route path="/exams/:id" element={<ProtectedRoute><ExamDetails /></ProtectedRoute>}></Route>
        <Route path="/recommendations" element={<ProtectedRoute><Recommendations /></ProtectedRoute>}></Route>
        <Route path="/freshness" element={<ProtectedRoute><FreshnessDashboard /></ProtectedRoute>}></Route>
      </Routes>
  ) ;
}

export default App;

// https://www.instagram.com/p/DbcegXIP7YW/?utm_source=ig_web_copy_link&igsh=NTc4MTIwNjQ2YQ==